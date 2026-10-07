import { randomUUID } from 'node:crypto';
import { Types } from 'mongoose';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { batchListResponseSchema, batchSummarySchema, referencesRequiredDetailsSchema, uploadsResponseSchema, type MediaObject } from '@rs/shared';
import { FAKE_JPEG } from '../../src/modules/ai/fake-media';
import { BatchModel } from '../../src/modules/batches/models';
import { MediaAssetModel } from '../../src/modules/media/models';
import { JobModel } from '../../src/modules/queue/models';
import { commonImageSpec, createBatch, defined, errorOf, getBatch, login, uploadReadyReferences, type ApiClient } from './support/client';
import { MONGO_START_TIMEOUT_MS, startE2e, type E2e } from './support/harness';

const SHOP_A = 'alpha-store.myshopify.com';
const SHOP_B = 'beta-store.myshopify.com';

let e2e: E2e;
let alpha: ApiClient;
let beta: ApiClient;
let gids: string[] = [];
let alphaImage: MediaObject;
let alphaSecondImage: MediaObject;
let betaImage: MediaObject;

beforeAll(async () => {
  e2e = await startE2e({
    dbName: 'rs_e2e_refs',
    config: (config) => {
      config.batch.maxActiveBatchesPerShop = 100;
    },
  });
  e2e.stub.addShop(SHOP_A);
  e2e.stub.addShop(SHOP_B);
  alpha = await login(e2e, SHOP_A);
  beta = await login(e2e, SHOP_B, { user: { id: 77, email: 'bea@example.com' } });
  gids = e2e.stub.shop(SHOP_A).products.map((product) => product.id);
  const alphaRefs = await uploadReadyReferences(alpha, [commonImageSpec('a-1', FAKE_JPEG), commonImageSpec('a-2', FAKE_JPEG)]);
  const betaRefs = await uploadReadyReferences(beta, [commonImageSpec('b-1', FAKE_JPEG)]);
  alphaImage = defined(alphaRefs[0]);
  alphaSecondImage = defined(alphaRefs[1]);
  betaImage = defined(betaRefs[0]);
}, MONGO_START_TIMEOUT_MS);

afterAll(async () => {
  await e2e.stop();
});

const gid = (index: number): string => defined(gids[index]);
const batchCount = (): Promise<number> => BatchModel.countDocuments();
const alphaShopId = (): Types.ObjectId => new Types.ObjectId(alpha.session.shop.id);

describe('reference resolution (SPEC 9)', () => {
  it('blocks a batch with unresolved products and names them', async () => {
    const res = await createBatch(alpha, {
      products: [{ productGid: gid(0), referenceMediaIds: [alphaImage.id] }, { productGid: gid(1) }, { productGid: gid(2) }],
    });
    expect(res.status).toBe(422);
    const error = errorOf(res);
    expect(error.code).toBe('references_required');
    expect(referencesRequiredDetailsSchema.parse(error.details).productGids).toEqual([gid(1), gid(2)]);
    expect(await batchCount()).toBe(0);
    // A request that is rejected up front costs no Shopify call.
    expect(e2e.stub.graphqlOperations(SHOP_A)).not.toContain('ProductSnapshots');
  });

  it('resolves every product when a common reference exists', async () => {
    const res = await createBatch(alpha, { products: [{ productGid: gid(1) }], commonReferenceMediaIds: [alphaImage.id] });
    expect(res.status).toBe(201);
    expect(batchSummarySchema.parse(res.body).counts.products).toBe(1);
  });

  it('rejects media ids that are not a usable reference of the shop', async () => {
    const attempt = (media: { common?: string[]; own?: string[] }) =>
      createBatch(alpha, { products: [{ productGid: gid(2), referenceMediaIds: media.own ?? [] }], commonReferenceMediaIds: media.common ?? [] });

    // Another shop's reference, as a common and as a product reference.
    for (const res of [await attempt({ common: [betaImage.id] }), await attempt({ own: [betaImage.id] })]) {
      expect(res.status).toBe(400);
      expect(errorOf(res)).toMatchObject({ code: 'validation_failed', details: { mediaIds: [betaImage.id] } });
    }
    // An id that does not exist, and an id that is not an object id at all.
    const missing = '0'.repeat(24);
    expect(errorOf(await attempt({ common: [missing] })).details).toEqual({ mediaIds: [missing] });
    expect((await attempt({ common: ['not-an-id'] })).status).toBe(400);

    // A reference whose upload was never completed.
    const staged = await alpha.post('/api/v1/media/uploads', {
      files: [{ clientId: 'late', filename: 'late.jpg', mimeType: 'image/jpeg', fileSize: FAKE_JPEG.byteLength, scope: 'common' }],
    });
    const awaitingId = defined(uploadsResponseSchema.parse(staged.body).targets[0]).mediaId;
    expect(errorOf(await attempt({ common: [awaitingId] })).details).toEqual({ mediaIds: [awaitingId] });

    expect(await batchCount()).toBe(1);
  });

  it('rejects an output and a deleted reference', async () => {
    const output = await MediaAssetModel.create({
      shopId: alphaShopId(),
      role: 'output',
      mediaType: 'image',
      status: 'ready',
      filename: 'rs-output.jpg',
      mimeType: 'image/jpeg',
      fileSize: 10,
      url: 'https://cdn.shopify.com/s/files/1/1/files/rs-output.jpg',
    });
    const asOutput = await createBatch(alpha, { products: [{ productGid: gid(2) }], commonReferenceMediaIds: [String(output._id)] });
    expect(asOutput.status).toBe(400);

    const [extra] = await uploadReadyReferences(alpha, [commonImageSpec('to-delete', FAKE_JPEG)]);
    expect((await alpha.delete(`/api/v1/media/${defined(extra).id}`)).status).toBe(204);
    expect(e2e.stub.graphqlOperations(SHOP_A)).toContain('FileDelete');
    const asDeleted = await createBatch(alpha, { products: [{ productGid: gid(2) }], commonReferenceMediaIds: [defined(extra).id] });
    expect(asDeleted.status).toBe(400);
  });

  it('applies the reference caps from the live config', async () => {
    e2e.editConfig((config) => {
      config.references.maxPerProduct = 1;
      config.references.maxCommon = 1;
    });
    const tooManyOwn = await createBatch(alpha, { products: [{ productGid: gid(2), referenceMediaIds: [alphaImage.id, alphaSecondImage.id] }] });
    expect(tooManyOwn.status).toBe(400);
    expect(errorOf(tooManyOwn).details).toMatchObject({ productGid: gid(2), maxPerProduct: 1 });
    const tooManyCommon = await createBatch(alpha, { products: [{ productGid: gid(2) }], commonReferenceMediaIds: [alphaImage.id, alphaSecondImage.id] });
    expect(tooManyCommon.status).toBe(400);
    expect(errorOf(tooManyCommon).details).toEqual({ maxCommon: 1 });

    const upload = await alpha.post('/api/v1/media/uploads', {
      files: ['c1', 'c2'].map((clientId) => ({ clientId, filename: `${clientId}.jpg`, mimeType: 'image/jpeg', fileSize: 10, scope: 'common' })),
    });
    expect(upload.status).toBe(400);
    expect(errorOf(upload).details).toMatchObject({ files: [{ clientId: 'c2', code: 'too_many_files' }] });

    e2e.editConfig((config) => {
      config.references.maxPerProduct = 5;
      config.references.maxCommon = 10;
    });
    const again = await createBatch(alpha, { products: [{ productGid: gid(2), referenceMediaIds: [alphaImage.id, alphaSecondImage.id] }] });
    expect(again.status).toBe(201);
  });

  it('answers 404 for a product the shop does not have', async () => {
    const res = await createBatch(alpha, { products: [{ productGid: 'gid://shopify/Product/42' }], commonReferenceMediaIds: [alphaImage.id] });
    expect(res.status).toBe(404);
    expect(errorOf(res)).toMatchObject({ code: 'not_found', details: { productGids: ['gid://shopify/Product/42'] } });
  });

  it('validates the body and requires a token', async () => {
    expect((await createBatch(alpha, { idempotencyKey: 'nope', products: [{ productGid: gid(0) }] })).status).toBe(400);
    expect((await createBatch(alpha, { products: [] })).status).toBe(400);
    const duplicate = await createBatch(alpha, { products: [{ productGid: gid(0) }, { productGid: gid(0) }], commonReferenceMediaIds: [alphaImage.id] });
    expect(duplicate.status).toBe(400);
    expect((await request(e2e.app).post('/api/v1/batches').send({})).status).toBe(401);
  });
});

describe('idempotent creation', () => {
  it('returns the first batch for a repeated key, also under concurrency', async () => {
    const before = await batchCount();
    const body = { idempotencyKey: randomUUID(), products: [{ productGid: gid(3) }], commonReferenceMediaIds: [alphaImage.id] };
    const first = await alpha.post('/api/v1/batches', body);
    const second = await alpha.post('/api/v1/batches', body);
    expect([first.status, second.status]).toEqual([201, 201]);
    expect(second.body).toEqual(first.body);
    expect(await batchCount()).toBe(before + 1);
    expect(await JobModel.countDocuments({ batchId: first.body.id })).toBe(4);

    // A repeated key wins over a changed body.
    const changed = await alpha.post('/api/v1/batches', { ...body, products: [{ productGid: gid(4) }] });
    expect(changed.body.id).toBe(first.body.id);

    const raceKey = randomUUID();
    const race = await Promise.all(Array.from({ length: 5 }, () => alpha.post('/api/v1/batches', { ...body, idempotencyKey: raceKey })));
    expect(race.map((res) => res.status)).toEqual(Array(5).fill(201));
    expect(new Set(race.map((res) => res.body.id)).size).toBe(1);
    expect(await batchCount()).toBe(before + 2);
    expect(await JobModel.countDocuments({ batchId: race[0]?.body.id })).toBe(4);
  });

  it('keeps a key private to its shop', async () => {
    const key = randomUUID();
    const mine = await alpha.post('/api/v1/batches', { idempotencyKey: key, products: [{ productGid: gid(3) }], commonReferenceMediaIds: [alphaImage.id] });
    const betaGid = defined(e2e.stub.shop(SHOP_B).products[0]).id;
    const theirs = await beta.post('/api/v1/batches', { idempotencyKey: key, products: [{ productGid: betaGid }], commonReferenceMediaIds: [betaImage.id] });
    expect([mine.status, theirs.status]).toEqual([201, 201]);
    expect(theirs.body.id).not.toBe(mine.body.id);
  });
});

describe('admission control (SPEC 10.6)', () => {
  it('limits active batches, products per batch and jobs per day with shop_limit', async () => {
    const create = (productCount: number) =>
      createBatch(alpha, { products: gids.slice(0, productCount).map((productGid) => ({ productGid })), commonReferenceMediaIds: [alphaImage.id] });
    const active = await BatchModel.countDocuments({ shopId: alphaShopId(), status: { $in: ['queued', 'running'] } });

    e2e.editConfig((config) => {
      config.batch.maxActiveBatchesPerShop = active;
    });
    const tooMany = await create(1);
    expect(tooMany.status).toBe(429);
    expect(errorOf(tooMany).code).toBe('shop_limit');

    e2e.editConfig((config) => {
      config.batch.maxActiveBatchesPerShop = 100;
      config.batch.maxProductsPerBatch = 2;
    });
    expect(errorOf(await create(3)).code).toBe('shop_limit');
    expect((await create(2)).status).toBe(201);

    const totals = await BatchModel.aggregate<{ used: number }>([
      { $match: { shopId: alphaShopId() } },
      { $group: { _id: null, used: { $sum: '$counts.jobsTotal' } } },
    ]);
    const used = totals[0]?.used ?? 0;
    e2e.editConfig((config) => {
      config.batch.maxProductsPerBatch = 50;
      config.batch.maxJobsPerShopPerDay = used;
    });
    expect(errorOf(await create(1)).code).toBe('shop_limit');
    e2e.editConfig((config) => {
      config.batch.maxJobsPerShopPerDay = 1000;
    });
  });
});

describe('deleting references', () => {
  it('refuses while a running batch uses the reference, allows it once the batches are cancelled', async () => {
    const blocked = await alpha.delete(`/api/v1/media/${alphaImage.id}`);
    expect(blocked.status).toBe(409);
    expect(errorOf(blocked).code).toBe('in_use');
    expect((await beta.delete(`/api/v1/media/${alphaImage.id}`)).status).toBe(404);

    const list = batchListResponseSchema.parse((await alpha.get('/api/v1/batches?limit=50')).body);
    const running = list.items.filter((batch) => batch.status === 'queued' || batch.status === 'running');
    expect(running.length).toBeGreaterThan(3);
    for (const batch of running) {
      const cancelled = batchSummarySchema.parse((await alpha.post(`/api/v1/batches/${batch.id}/cancel`)).body);
      expect(cancelled).toMatchObject({ status: 'cancelled', counts: { jobsCancelled: batch.counts.jobsTotal } });
    }

    expect((await alpha.delete(`/api/v1/media/${alphaImage.id}`)).status).toBe(204);
    const row = await MediaAssetModel.findById(alphaImage.id).lean();
    expect(row?.status).toBe('deleted');
    expect(e2e.stub.shop(SHOP_A).files.has(defined(row?.shopify?.fileGid))).toBe(false);
    expect((await getBatch(alpha, defined(running[0]).id)).status).toBe('cancelled');
  });
});
