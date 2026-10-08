import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  batchDetailSchema,
  attachMediaResponseSchema,
  batchListResponseSchema,
  batchSummarySchema,
  referencesRequiredDetailsSchema,
  type Api,
  type BatchDetail,
  type CreateBatchInput,
} from '@rs/shared';
import { MAX_ACTIVE_BATCHES } from '../src/batchStore';
import { objectId, productGid } from '../src/util';
import { advance, cleanup, expectApiError, freshApi } from './helpers';

let api: Api;
beforeEach(() => {
  api = freshApi();
});
afterEach(cleanup);

const COMMON = [objectId(1)];
let keyCounter = 0;

function input(productCount: number): CreateBatchInput {
  keyCounter += 1;
  return {
    idempotencyKey: `00000000-0000-4000-8000-${String(keyCounter).padStart(12, '0')}`,
    products: Array.from({ length: productCount }, (_, index) => ({ productGid: productGid(index) })),
    commonReferenceMediaIds: COMMON,
  };
}

async function detail(id: string): Promise<BatchDetail> {
  return batchDetailSchema.parse(await api.batches.get(id));
}

// Timeline of a 2 product batch (see batchStore.ts), in ms after creation:
//   product 1: plan 1000-2500, images done 4500 and 6000, video done 10000
//   product 2: plan 2500-4000, images done 6000 and 7500, video 11500 and it FAILS (safety_blocked)
//   delay object present from 3500 up to 9000
describe('batch progression', () => {
  it('walks queued -> running -> completed_with_errors with validating snapshots', async () => {
    const { id, status } = batchSummarySchema.parse(await api.batches.create(input(2)));
    expect(status).toBe('queued');

    const queued = await detail(id);
    expect(queued.items.map((item) => item.status)).toEqual(['pending', 'pending']);
    expect(queued.items[0]?.jobs.map((job) => job.status)).toEqual(['queued', 'blocked', 'blocked', 'blocked']);
    expect(queued.delay).toBeNull();
    expect(queued.finishedAt).toBeNull();
    expect(queued.counts).toMatchObject({ products: 2, jobsTotal: 8, jobsSucceeded: 0 });

    advance(1_000);
    const planning = await detail(id);
    expect(planning.status).toBe('running');
    expect(planning.items.map((item) => item.status)).toEqual(['planning', 'pending']);

    advance(3_000);
    const delayed = await detail(id);
    expect(delayed.delay).toMatchObject({ reason: 'rate_limited' });
    expect(delayed.items.map((item) => item.status)).toEqual(['generating', 'generating']);
    expect(delayed.items[0]?.outputs).toHaveLength(0);

    advance(1_000);
    const firstImage = await detail(id);
    expect(firstImage.items[0]?.outputs.map((output) => output.mediaType)).toEqual(['image']);
    expect(firstImage.counts).toMatchObject({ imagesReady: 1, videosReady: 0 });

    advance(5_000);
    const afterDelay = await detail(id);
    expect(afterDelay.delay).toBeNull();
    expect(afterDelay.status).toBe('running');
    expect(afterDelay.counts.imagesReady).toBe(4);

    advance(3_000);
    const done = await detail(id);
    expect(done.status).toBe('completed_with_errors');
    expect(done.items.map((item) => item.status)).toEqual(['completed', 'partial']);
    expect(done.counts).toMatchObject({
      jobsTotal: 8,
      jobsSucceeded: 7,
      jobsFailed: 1,
      jobsCancelled: 0,
      imagesReady: 4,
      videosReady: 1,
    });
    expect(done.items[1]?.jobs.at(-1)).toMatchObject({ type: 'video', status: 'failed', errorCode: 'safety_blocked' });
    expect(done.finishedAt).toBe(new Date(new Date(done.createdAt).getTime() + 11_500).toISOString());
    expect(done.coverImageUrl).toBe(done.items[0]?.imageUrl);
  });

  it('fails the video of a single product batch and restores it on retry', async () => {
    const { id } = await api.batches.create(input(1));
    advance(11_000);
    const partial = await detail(id);
    expect(partial.status).toBe('completed_with_errors');
    expect(partial.items[0]).toMatchObject({ status: 'partial', referenceMode: 'common_only' });
    expect(partial.items[0]?.outputs.map((output) => [output.mediaType, output.status])).toEqual([
      ['image', 'ready'],
      ['image', 'ready'],
    ]);

    await api.batches.retryFailed(id);
    advance(6_000);
    const done = await detail(id);
    expect(done.status).toBe('completed');
    expect(done.items[0]?.outputs.map((output) => output.mediaType)).toEqual(['image', 'image', 'video']);
  });

  it('lists seeded and new batches newest first and pages them', async () => {
    const { id } = await api.batches.create(input(1));
    const all = batchListResponseSchema.parse(await api.batches.list());
    expect(all.items).toHaveLength(4);
    expect(all.items[0]?.id).toBe(id);
    const dates = all.items.map((batch) => batch.createdAt);
    expect([...dates].sort().reverse()).toEqual(dates);

    const first = batchListResponseSchema.parse(await api.batches.list({ limit: 3 }));
    expect(first.pageInfo.hasNextPage).toBe(true);
    const second = batchListResponseSchema.parse(await api.batches.list({ limit: 3, cursor: first.pageInfo.endCursor ?? undefined }));
    expect(second.items).toHaveLength(1);
    expect(second.pageInfo.hasNextPage).toBe(false);
  });

  it('seeds a completed, a completed_with_errors and a cancelled batch', async () => {
    const statuses = batchListResponseSchema.parse(await api.batches.list()).items.map((batch) => batch.status);
    expect(statuses).toEqual(['completed', 'completed_with_errors', 'cancelled']);
  });
});

describe('cancel and retry failed', () => {
  it('freezes the clock on cancel: finished jobs stay, the rest are cancelled', async () => {
    const { id } = await api.batches.create(input(2));
    advance(5_000);
    const cancelled = batchSummarySchema.parse(await api.batches.cancel(id));
    expect(cancelled.status).toBe('cancelled');
    expect(cancelled.finishedAt).not.toBeNull();

    const frozen = await detail(id);
    advance(20_000);
    const later = await detail(id);
    expect(later).toEqual(frozen);
    expect(later.counts.imagesReady).toBe(1);
    expect(later.counts.jobsCancelled).toBeGreaterThan(0);
    expect(later.items.every((item) => item.status === 'cancelled')).toBe(true);
    const cancelledJobs = later.items.flatMap((item) => item.jobs).filter((job) => job.status === 'cancelled');
    expect(cancelledJobs.every((job) => job.errorCode === 'cancelled')).toBe(true);
  });

  it('leaves a finished batch alone when cancelling', async () => {
    const [completed] = batchListResponseSchema.parse(await api.batches.list()).items;
    const result = await api.batches.cancel(completed?.id ?? '');
    expect(result.status).toBe('completed');
  });

  it('retries the failed video once and then completes the batch', async () => {
    const { id } = await api.batches.create(input(2));
    advance(12_000);
    expect((await detail(id)).status).toBe('completed_with_errors');

    const retried = batchSummarySchema.parse(await api.batches.retryFailed(id));
    expect(retried.status).toBe('running');
    expect(retried.finishedAt).toBeNull();

    const queued = await detail(id);
    expect(queued.items[1]?.jobs.at(-1)).toMatchObject({ status: 'queued', errorCode: null });
    advance(1_000);
    expect((await detail(id)).items[1]?.jobs.at(-1)?.status).toBe('awaiting_operation');

    advance(5_000);
    const done = await detail(id);
    expect(done.status).toBe('completed');
    expect(done.counts).toMatchObject({ jobsSucceeded: 8, jobsFailed: 0, videosReady: 2 });

    const again = await api.batches.retryFailed(id);
    expect(again.status).toBe('completed');
  });

  it('ignores retry on a batch that is still running', async () => {
    const { id } = await api.batches.create(input(1));
    advance(3_000);
    const result = await api.batches.retryFailed(id);
    expect(result.status).toBe('running');
    expect((await detail(id)).items[0]?.jobs.some((job) => job.status === 'queued')).toBe(false);
  });
});

describe('batch errors', () => {
  it('returns the same batch for the same idempotency key', async () => {
    const body = input(1);
    const first = await api.batches.create(body);
    advance(2_000);
    const second = await api.batches.create(body);
    expect(second.id).toBe(first.id);
    expect(batchListResponseSchema.parse(await api.batches.list()).items).toHaveLength(4);
  });

  it('422s references_required and names the product gids', async () => {
    const error = await expectApiError(
      api.batches.create({
        idempotencyKey: '00000000-0000-4000-8000-0000000000aa',
        products: [{ productGid: productGid(0), referenceMediaIds: [objectId(2)] }, { productGid: productGid(1) }],
      }),
      'references_required',
    );
    expect(referencesRequiredDetailsSchema.parse(error.details)).toEqual({ productGids: [productGid(1)] });
  });

  it('400s validation_failed for a product that does not exist', async () => {
    await expectApiError(
      api.batches.create({
        idempotencyKey: '00000000-0000-4000-8000-0000000000bb',
        products: [{ productGid: productGid(500) }],
        commonReferenceMediaIds: COMMON,
      }),
      'validation_failed',
    );
  });

  it('404s for an unknown batch on get, cancel and retry', async () => {
    const id = 'e'.repeat(24);
    await expectApiError(api.batches.get(id), 'not_found');
    await expectApiError(api.batches.cancel(id), 'not_found');
    await expectApiError(api.batches.retryFailed(id), 'not_found');
    await expectApiError(api.batches.attachMedia(id), 'not_found');
  });
});

describe('shop_limit', () => {
  it('429s the 4th concurrent batch and admits it once one has finished', async () => {
    for (let index = 0; index < MAX_ACTIVE_BATCHES; index += 1) await api.batches.create(input(1));
    const error = await expectApiError(api.batches.create(input(1)), 'shop_limit');
    expect(error.message).toContain(String(MAX_ACTIVE_BATCHES));

    advance(12_000);
    const admitted = batchSummarySchema.parse(await api.batches.create(input(1)));
    expect(admitted.status).toBe('queued');
  });

  it('admits a new batch right after an active one was cancelled', async () => {
    const ids: string[] = [];
    for (let index = 0; index < MAX_ACTIVE_BATCHES; index += 1) ids.push((await api.batches.create(input(1))).id);
    await api.batches.cancel(ids[0] ?? '');
    expect((await api.batches.create(input(1))).status).toBe('queued');
  });
});

describe('attach media', () => {
  // The first seeded batch is complete: three products with two images and one video each.
  async function seededId(): Promise<string> {
    const list = batchListResponseSchema.parse(await api.batches.list({ limit: 10 }));
    const seeded = list.items.find((batch) => batch.status === 'completed');
    if (seeded === undefined) throw new Error('no completed seeded batch');
    return seeded.id;
  }

  it('puts every ready output of every item on its product and stamps attachedAt', async () => {
    const id = await seededId();
    const before = await detail(id);
    expect(before.items.flatMap((item) => item.outputs).every((output) => !output.attachedAt)).toBe(true);

    const result = attachMediaResponseSchema.parse(await api.batches.attachMedia(id));
    expect(result).toMatchObject({ attached: 9, alreadyAttached: 0, failed: 0 });
    expect(result.items.map((row) => row.itemId)).toEqual(before.items.map((item) => item.id));
    expect(result.items.map((row) => row.productGid)).toEqual(before.items.map((item) => item.productGid));
    expect(result.items.every((row) => row.attached === 3 && row.error === null)).toBe(true);

    const after = await detail(id);
    const outputs = after.items.flatMap((item) => item.outputs);
    expect(outputs).toHaveLength(9);
    expect(outputs.every((output) => typeof output.attachedAt === 'string')).toBe(true);
  });

  it('is idempotent: a second call finds everything attached already', async () => {
    const id = await seededId();
    await api.batches.attachMedia(id);
    const again = attachMediaResponseSchema.parse(await api.batches.attachMedia(id));
    expect(again).toMatchObject({ attached: 0, alreadyAttached: 9, failed: 0 });
    expect(again.items.every((row) => row.attached === 0 && row.alreadyAttached === 3)).toBe(true);
  });

  it('attaches only the requested items', async () => {
    const id = await seededId();
    const [first, second] = (await detail(id)).items;
    const result = attachMediaResponseSchema.parse(await api.batches.attachMedia(id, { itemIds: [second?.id ?? ''] }));
    expect(result.items.map((row) => row.itemId)).toEqual([second?.id]);
    expect(result.attached).toBe(3);

    const after = await detail(id);
    const attachedOf = (itemId: string | undefined) =>
      after.items.find((item) => item.id === itemId)?.outputs.map((output) => output.attachedAt != null);
    expect(attachedOf(first?.id)).toEqual([false, false, false]);
    expect(attachedOf(second?.id)).toEqual([true, true, true]);
  });

  it('attaches only the outputs that are ready so far, and the rest later', async () => {
    const created = await api.batches.create(input(1));
    advance(5_000);
    const first = attachMediaResponseSchema.parse(await api.batches.attachMedia(created.id));
    expect(first).toMatchObject({ attached: 1, alreadyAttached: 0 });

    advance(10_000);
    const second = attachMediaResponseSchema.parse(await api.batches.attachMedia(created.id));
    expect(second).toMatchObject({ alreadyAttached: 1 });
    expect(second.attached).toBeGreaterThan(0);
  });

  it('reports an item without ready outputs with zero counts', async () => {
    const created = await api.batches.create(input(1));
    const result = attachMediaResponseSchema.parse(await api.batches.attachMedia(created.id));
    expect(result).toMatchObject({ attached: 0, alreadyAttached: 0, failed: 0 });
    expect(result.items).toHaveLength(1);
  });
});
