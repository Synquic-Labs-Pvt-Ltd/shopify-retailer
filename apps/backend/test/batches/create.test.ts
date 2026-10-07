import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { batchSummarySchema, referencesRequiredDetailsSchema, type BatchSummary } from '@rs/shared';
import { AppError } from '../../src/core/errors';
import { BatchItemModel, BatchModel } from '../../src/modules/batches/models';
import { JobModel } from '../../src/modules/queue/models';
import { MONGO_START_TIMEOUT_MS, startTestMongo, type TestMongo } from '../helpers/mongo';
import { createKit, prepareIndexes, SHOP_A, SHOP_B, type Kit } from './kit';

let mongo: TestMongo;
let kit: Kit;

beforeAll(async () => {
  mongo = await startTestMongo('rs_batches_create');
}, MONGO_START_TIMEOUT_MS);

afterAll(async () => {
  await mongo.stop();
});

beforeEach(async () => {
  await mongo.clear();
  kit = createKit();
  await prepareIndexes(kit);
});

async function rejection(promise: Promise<unknown>): Promise<AppError> {
  try {
    await promise;
  } catch (err) {
    if (err instanceof AppError) return err;
    throw err;
  }
  throw new Error('expected the call to be rejected');
}

describe('createBatch: jobs, items and the config snapshot', () => {
  it('creates items and the plan, image and video jobs with lanes, dependencies and output indexes', async () => {
    const [p1, p2, p3] = kit.products(3) as [string, string, string];
    const own = kit.reference();
    const common = kit.reference();
    const summary = await kit.create({
      products: [{ productGid: p1, referenceMediaIds: [own] }, { productGid: p2 }, { productGid: p3 }],
      commonReferenceMediaIds: [common],
    });

    expect(batchSummarySchema.parse(summary)).toEqual(summary);
    expect(summary.status).toBe('queued');
    expect(summary.counts).toMatchObject({ products: 3, jobsTotal: 12, jobsSucceeded: 0, imagesReady: 0 });
    expect(summary.configSnapshot.outputs).toEqual({ imagesPerProduct: 2, videosPerProduct: 1 });
    expect(summary.coverImageUrl).toContain('/p/1001-1.jpg');

    const jobs = await kit.queue.store.listByBatch(SHOP_A, summary.id);
    expect(jobs).toHaveLength(12);
    const items = await BatchItemModel.find({ batchId: summary.id }).sort({ _id: 1 }).lean();
    expect(items.map((item) => item.referenceMode)).toEqual(['own_plus_common', 'common_only', 'common_only']);
    expect(items[0]?.ownReferenceMediaIds.map(String)).toEqual([own]);
    expect(items[0]?.effectiveReferenceMediaIds.map(String)).toEqual([own, common]);
    expect(items[1]?.ownReferenceMediaIds).toEqual([]);
    expect(items[1]?.effectiveReferenceMediaIds.map(String)).toEqual([common]);

    for (const item of items) {
      const own = jobs.filter((job) => job.batchItemId === String(item._id));
      const plan = own.find((job) => job.type === 'plan');
      expect(plan).toMatchObject({ lane: 'fake:fake-planner', status: 'queued', dependsOn: [] });
      const images = own.filter((job) => job.type === 'image');
      const videos = own.filter((job) => job.type === 'video');
      expect(images.map((job) => job.outputIndex).sort()).toEqual([0, 1]);
      expect(videos.map((job) => job.outputIndex)).toEqual([0]);
      for (const job of [...images, ...videos]) {
        expect(job.status).toBe('blocked');
        expect(job.dependsOn).toEqual([plan?.id]);
      }
      expect(images.every((job) => job.lane === 'fake:fake-image')).toBe(true);
      expect(videos.every((job) => job.lane === 'fake:fake-video')).toBe(true);
    }
  });

  it('freezes the generation settings: editing the live config affects only new batches', async () => {
    const [p1] = kit.products(1) as [string];
    const common = kit.reference();
    const first = await kit.create({ products: [{ productGid: p1 }], commonReferenceMediaIds: [common] });

    kit.config.current.outputs = { imagesPerProduct: 1, videosPerProduct: 0 };
    kit.config.current.models = { planner: 'p2', image: 'i2', video: 'v2' };
    const [p2] = kit.products(1) as [string];
    const second = await kit.create({ products: [{ productGid: p2 }], commonReferenceMediaIds: [common] });

    const stored = await BatchModel.findById(first.id).lean();
    expect(stored?.configSnapshot).toMatchObject({
      outputs: { imagesPerProduct: 2, videosPerProduct: 1 },
      provider: 'fake',
      models: { planner: 'fake-planner', image: 'fake-image', video: 'fake-video' },
      image: { aspectRatio: '3:4' },
      video: { mode: 'reference_images' },
      promptVersions: kit.prompts.getPromptVersions(),
    });
    expect(first.counts.jobsTotal).toBe(4);
    expect(second.counts.jobsTotal).toBe(2);
    const secondJobs = await kit.queue.store.listByBatch(SHOP_A, second.id);
    expect(secondJobs.map((job) => job.lane).sort()).toEqual(['fake:i2', 'fake:p2']);
  });

  it('cancels what it created and marks the batch failed when enqueueing fails part-way', async () => {
    const products = kit.products(3);
    const common = kit.reference();
    const original = kit.queue.store.enqueue.bind(kit.queue.store);
    let calls = 0;
    kit.queue.store.enqueue = async (job) => {
      calls += 1;
      if (calls === 6) throw new Error('mongo went away');
      return original(job);
    };

    const failure = await rejection(
      kit.create({ products: products.map((productGid) => ({ productGid })), commonReferenceMediaIds: [common] }),
    );
    expect(failure.code).toBe('internal');

    const batch = await BatchModel.findOne({ shopId: SHOP_A }).lean();
    expect(batch?.status).toBe('failed');
    expect(batch?.cancelRequestedAt).toBeInstanceOf(Date);
    const jobs = await JobModel.find({ batchId: batch?._id }).lean();
    expect(jobs).toHaveLength(7);
    expect(batch?.counts.jobsTotal).toBe(7);
    expect(jobs.every((job) => job.status === 'cancelled')).toBe(true);
  });
});

describe('reference resolution (SPEC 9)', () => {
  it.each([
    { name: 'own and common', own: 1, common: 1, mode: 'own_plus_common', effective: 2 },
    { name: 'own only', own: 2, common: 0, mode: 'own_only', effective: 2 },
    { name: 'common only', own: 0, common: 2, mode: 'common_only', effective: 2 },
  ])('$name resolves to $mode', async ({ own, common, mode, effective }) => {
    const [gid] = kit.products(1) as [string];
    const ownIds = Array.from({ length: own }, () => kit.reference());
    const commonIds = Array.from({ length: common }, () => kit.reference());
    const summary = await kit.create({ products: [{ productGid: gid, referenceMediaIds: ownIds }], commonReferenceMediaIds: commonIds });
    const item = await BatchItemModel.findOne({ batchId: summary.id }).lean();
    expect(item?.referenceMode).toBe(mode);
    expect(item?.effectiveReferenceMediaIds).toHaveLength(effective);
    expect(item?.effectiveReferenceMediaIds.map(String)).toEqual([...ownIds, ...commonIds]);
  });

  it('answers 422 references_required with the unresolved productGids and creates nothing', async () => {
    const [a, b, c] = kit.products(3) as [string, string, string];
    const own = kit.reference();
    const response = await kit
      .api()
      .post('/batches')
      .send({
        idempotencyKey: crypto.randomUUID(),
        products: [{ productGid: a, referenceMediaIds: [own] }, { productGid: b }, { productGid: c, referenceMediaIds: [] }],
        commonReferenceMediaIds: [],
      });
    expect(response.status).toBe(422);
    expect(response.body.error.code).toBe('references_required');
    expect(referencesRequiredDetailsSchema.parse(response.body.error.details).productGids).toEqual([b, c]);
    expect(await BatchModel.countDocuments()).toBe(0);
  });

  it('puts own references before common ones, de-duplicated, mixing images and videos', async () => {
    const [gid] = kit.products(1) as [string];
    const ownVideo = kit.reference(SHOP_A, 'video');
    const ownImage = kit.reference();
    const commonImage = kit.reference();
    const commonVideo = kit.reference(SHOP_A, 'video');
    const summary = await kit.create({
      products: [{ productGid: gid, referenceMediaIds: [ownVideo, ownImage, ownVideo] }],
      commonReferenceMediaIds: [commonImage, ownImage, commonVideo],
    });
    const item = await BatchItemModel.findOne({ batchId: summary.id }).lean();
    expect(item?.ownReferenceMediaIds.map(String)).toEqual([ownVideo, ownImage]);
    expect(item?.effectiveReferenceMediaIds.map(String)).toEqual([ownVideo, ownImage, commonImage, commonVideo]);
  });

  it('enforces references.maxPerProduct and references.maxCommon', async () => {
    const [gid] = kit.products(1) as [string];
    const tooManyOwn = Array.from({ length: 6 }, () => kit.reference());
    const ownError = await rejection(kit.create({ products: [{ productGid: gid, referenceMediaIds: tooManyOwn }] }));
    expect(ownError.code).toBe('validation_failed');

    const tooManyCommon = Array.from({ length: 11 }, () => kit.reference());
    const commonError = await rejection(kit.create({ products: [{ productGid: gid }], commonReferenceMediaIds: tooManyCommon }));
    expect(commonError.code).toBe('validation_failed');

    const atCap = Array.from({ length: 5 }, () => kit.reference());
    await expect(kit.create({ products: [{ productGid: gid, referenceMediaIds: atCap }] })).resolves.toMatchObject({ status: 'queued' });
  });

  it.each([
    { name: 'a media id that does not exist', make: () => '0'.repeat(24) },
    { name: 'another shop media', make: () => kit.reference(SHOP_B) },
    { name: 'an output, not a reference', make: () => kit.media.addReference({ shopId: SHOP_A, role: 'output' }) },
    { name: 'a reference that is still processing', make: () => kit.media.addReference({ shopId: SHOP_A, status: 'processing' }) },
    { name: 'a failed reference', make: () => kit.media.addReference({ shopId: SHOP_A, status: 'failed' }) },
    { name: 'a deleted reference', make: () => kit.media.addReference({ shopId: SHOP_A, status: 'deleted' }) },
  ])('rejects $name with validation_failed', async ({ make }) => {
    const [gid] = kit.products(1) as [string];
    const bad = make();
    const error = await rejection(kit.create({ products: [{ productGid: gid, referenceMediaIds: [bad] }] }));
    expect(error.code).toBe('validation_failed');
    expect(error.details).toEqual({ mediaIds: [bad] });
    expect(await BatchModel.countDocuments()).toBe(0);
  });

  it('answers not_found for a product the catalog does not know', async () => {
    const common = kit.reference();
    const error = await rejection(
      kit.create({ products: [{ productGid: 'gid://shopify/Product/999' }], commonReferenceMediaIds: [common] }),
    );
    expect(error.code).toBe('not_found');
    expect(await BatchModel.countDocuments()).toBe(0);
  });
});

describe('idempotency', () => {
  it('returns the first batch for a repeated key, sequentially and concurrently', async () => {
    const [gid] = kit.products(1) as [string];
    const common = kit.reference();
    const key = crypto.randomUUID();
    const input = { idempotencyKey: key, products: [{ productGid: gid }], commonReferenceMediaIds: [common] };

    const first = await kit.create(input);
    const again = await kit.create(input);
    expect(again).toEqual(first);

    const key2 = crypto.randomUUID();
    const racing = await Promise.all(
      Array.from({ length: 4 }, () => kit.create({ ...input, idempotencyKey: key2 })),
    );
    expect(new Set(racing.map((summary) => summary.id)).size).toBe(1);
    expect(await BatchModel.countDocuments({ shopId: SHOP_A })).toBe(2);
    expect(await JobModel.countDocuments({ batchId: racing[0]?.id })).toBe(4);
  });

  it('replays through the API with the same status, and scopes the key to the shop', async () => {
    const [gid] = kit.products(1) as [string];
    const commonA = kit.reference(SHOP_A);
    const commonB = kit.reference(SHOP_B);
    const key = crypto.randomUUID();
    const body = (common: string) => ({ idempotencyKey: key, products: [{ productGid: gid }], commonReferenceMediaIds: [common] });

    const first = await kit.api(SHOP_A).post('/batches').send(body(commonA));
    const replay = await kit.api(SHOP_A).post('/batches').send(body(commonA));
    const otherShop = await kit.api(SHOP_B).post('/batches').send(body(commonB));
    expect([first.status, replay.status, otherShop.status]).toEqual([201, 201, 201]);
    expect(replay.body).toEqual(first.body);
    expect(otherShop.body.id).not.toBe(first.body.id);
  });
});

describe('admission control (SPEC 10.6)', () => {
  it('rejects more products than batch.maxProductsPerBatch', async () => {
    kit.config.current.batch.maxProductsPerBatch = 2;
    const gids = kit.products(3);
    const common = kit.reference();
    const error = await rejection(kit.create({ products: gids.map((productGid) => ({ productGid })), commonReferenceMediaIds: [common] }));
    expect(error).toMatchObject({ code: 'shop_limit', status: 429 });
  });

  it('allows batch.maxActiveBatchesPerShop non-terminal batches and counts only this shop', async () => {
    kit.config.current.batch.maxActiveBatchesPerShop = 2;
    const common = kit.reference();
    const commonB = kit.reference(SHOP_B);
    const make = (shopId: string, ref: string) => kit.create({ products: kit.products(1).map((productGid) => ({ productGid })), commonReferenceMediaIds: [ref] }, shopId);

    await make(SHOP_A, common);
    await make(SHOP_A, common);
    const error = await rejection(make(SHOP_A, common));
    expect(error).toMatchObject({ code: 'shop_limit', status: 429 });
    await expect(make(SHOP_B, commonB)).resolves.toMatchObject({ status: 'queued' });

    // A finished batch no longer counts.
    await BatchModel.updateOne({ shopId: SHOP_A }, { $set: { status: 'completed' } });
    await expect(make(SHOP_A, common)).resolves.toMatchObject({ status: 'queued' });
  });

  it('caps the jobs created per UTC day across batches and resets at midnight', async () => {
    kit.config.current.batch.maxJobsPerShopPerDay = 10;
    kit.config.current.batch.maxActiveBatchesPerShop = 10;
    const common = kit.reference();
    const make = (count: number) =>
      kit.create({ products: kit.products(count).map((productGid) => ({ productGid })), commonReferenceMediaIds: [common] });

    await make(2); // 8 jobs
    const error = await rejection(make(1)); // 4 more would make 12
    expect(error).toMatchObject({ code: 'shop_limit', status: 429 });
    expect(error.message).toContain('daily limit');

    kit.clock.advance(12 * 3_600_000); // past 00:00 UTC next day
    await expect(make(2)).resolves.toMatchObject({ counts: { jobsTotal: 8 } });
  });

  it('answers 429 over the API and 409 shop_reauth_required for an inactive shop', async () => {
    kit.config.current.batch.maxProductsPerBatch = 1;
    const gids = kit.products(2);
    const common = kit.reference();
    const response = await kit
      .api()
      .post('/batches')
      .send({ idempotencyKey: crypto.randomUUID(), products: gids.map((productGid) => ({ productGid })), commonReferenceMediaIds: [common] });
    expect(response.status).toBe(429);
    expect(response.body.error.code).toBe('shop_limit');

    kit.shopStatus.set(SHOP_A, 'reauth_required');
    const inactive = await kit
      .api()
      .post('/batches')
      .send({ idempotencyKey: crypto.randomUUID(), products: [{ productGid: gids[0] }], commonReferenceMediaIds: [common] });
    expect(inactive.status).toBe(409);
  });
});

describe('validation and tenant isolation', () => {
  it('rejects malformed bodies with validation_failed', async () => {
    const empty = await kit.api().post('/batches').send({ idempotencyKey: 'nope', products: [] });
    expect(empty.status).toBe(400);
    expect(empty.body.error.code).toBe('validation_failed');
    const duplicate = await kit
      .api()
      .post('/batches')
      .send({
        idempotencyKey: crypto.randomUUID(),
        products: [{ productGid: 'gid://shopify/Product/1' }, { productGid: 'gid://shopify/Product/1' }],
      });
    expect(duplicate.status).toBe(400);
  });

  it('never shows, cancels or retries another shop batch (404), and lists only the own shop', async () => {
    const common = kit.reference();
    const mine = await kit.create({ products: kit.products(1).map((productGid) => ({ productGid })), commonReferenceMediaIds: [common] });

    const asB = kit.api(SHOP_B);
    expect((await asB.get(`/batches/${mine.id}`)).status).toBe(404);
    expect((await asB.post(`/batches/${mine.id}/cancel`)).status).toBe(404);
    expect((await asB.post(`/batches/${mine.id}/retry-failed`)).status).toBe(404);
    expect((await asB.get('/batches')).body.items).toEqual([]);
    expect((await kit.api().get('/batches')).body.items.map((item: BatchSummary) => item.id)).toEqual([mine.id]);
    expect((await kit.api().get(`/batches/${'0'.repeat(24)}`)).status).toBe(404);
    expect((await kit.api().get('/batches/not-an-id')).status).toBe(400);
    expect((await kit.api().get(`/batches/${mine.id}`)).status).toBe(200);
    // The batch was left untouched by the other shop.
    expect((await kit.detail(mine.id)).status).toBe('queued');
  });

  it('paginates the list newest first with a cursor', async () => {
    kit.config.current.batch.maxActiveBatchesPerShop = 10;
    const common = kit.reference();
    const ids: string[] = [];
    for (let i = 0; i < 5; i += 1) {
      const summary = await kit.create({ products: kit.products(1).map((productGid) => ({ productGid })), commonReferenceMediaIds: [common] });
      ids.push(summary.id);
      kit.clock.advance(1000);
    }
    const page1 = (await kit.api().get('/batches?limit=2')).body;
    expect(page1.items.map((item: BatchSummary) => item.id)).toEqual([ids[4], ids[3]]);
    expect(page1.pageInfo.hasNextPage).toBe(true);
    const page2 = (await kit.api().get(`/batches?limit=2&cursor=${page1.pageInfo.endCursor}`)).body;
    expect(page2.items.map((item: BatchSummary) => item.id)).toEqual([ids[2], ids[1]]);
    const page3 = (await kit.api().get(`/batches?limit=2&cursor=${page2.pageInfo.endCursor}`)).body;
    expect(page3.items.map((item: BatchSummary) => item.id)).toEqual([ids[0]]);
    expect(page3.pageInfo).toEqual({ endCursor: null, hasNextPage: false });
    expect((await kit.api().get('/batches?cursor=garbage')).status).toBe(400);
  });
});

describe('isMediaInUse and purgeShop', () => {
  it('is true while a non-terminal batch uses the media as a common or effective reference', async () => {
    const [p1, p2] = kit.products(2) as [string, string];
    const own = kit.reference();
    const common = kit.reference();
    const unused = kit.reference();
    const summary = await kit.create({
      products: [{ productGid: p1, referenceMediaIds: [own] }, { productGid: p2 }],
      commonReferenceMediaIds: [common],
    });
    const { service } = kit.batches;
    expect(await service.isMediaInUse(SHOP_A, own)).toBe(true);
    expect(await service.isMediaInUse(SHOP_A, common)).toBe(true);
    expect(await service.isMediaInUse(SHOP_A, unused)).toBe(false);
    expect(await service.isMediaInUse(SHOP_B, own)).toBe(false);
    expect(await service.isMediaInUse(SHOP_A, 'not-an-id')).toBe(false);

    await kit.driveToTerminal(summary.id);
    expect(await service.isMediaInUse(SHOP_A, own)).toBe(false);
    expect(await service.isMediaInUse(SHOP_A, common)).toBe(false);
  });

  it('purgeShop removes the shop batches and items and nothing else', async () => {
    const commonA = kit.reference(SHOP_A);
    const commonB = kit.reference(SHOP_B);
    await kit.create({ products: kit.products(2).map((productGid) => ({ productGid })), commonReferenceMediaIds: [commonA] });
    const other = await kit.create({ products: kit.products(1).map((productGid) => ({ productGid })), commonReferenceMediaIds: [commonB] }, SHOP_B);

    await kit.batches.service.purgeShop(SHOP_A);
    expect(await BatchModel.countDocuments({ shopId: SHOP_A })).toBe(0);
    expect(await BatchItemModel.countDocuments({ shopId: SHOP_A })).toBe(0);
    expect(await BatchModel.countDocuments({ shopId: SHOP_B })).toBe(1);
    expect(await BatchItemModel.countDocuments({ batchId: other.id })).toBe(1);
  });
});
