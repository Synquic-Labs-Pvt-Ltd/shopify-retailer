import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { batchSummarySchema, type BatchDetail, type MediaObject } from '@rs/shared';
import { FAKE_JPEG } from '../../src/modules/ai/fake-media';
import { BatchItemModel } from '../../src/modules/batches/models';
import { MediaAssetModel } from '../../src/modules/media/models';
import { JobModel } from '../../src/modules/queue/models';
import { commonImageSpec, createBatch, defined, errorOf, getBatch, login, uploadReadyReferences, type ApiClient } from './support/client';
import { MONGO_START_TIMEOUT_MS, startE2e, type E2e } from './support/harness';
import { sleep } from './support/wait';

const SHOP = 'cancel-store.myshopify.com';

let e2e: E2e;
let client: ApiClient;
let reference: MediaObject;
let gids: string[] = [];

beforeAll(async () => {
  e2e = await startE2e({
    dbName: 'rs_e2e_cancel',
    config: (config) => {
      config.queue.maxAttempts = 2;
    },
  });
  e2e.stub.addShop(SHOP);
  client = await login(e2e, SHOP);
  gids = e2e.stub.shop(SHOP).products.map((product) => product.id);
  reference = defined((await uploadReadyReferences(client, [commonImageSpec('common', FAKE_JPEG)]))[0]);
}, MONGO_START_TIMEOUT_MS);

afterAll(async () => {
  await e2e.stop();
});

async function newBatch(productIndexes: number[]): Promise<string> {
  const res = await createBatch(client, {
    products: productIndexes.map((index) => ({ productGid: defined(gids[index]) })),
    commonReferenceMediaIds: [reference.id],
  });
  expect(res.status).toBe(201);
  return batchSummarySchema.parse(res.body).id;
}

const jobsOf = (batchId: string) => JobModel.find({ batchId }).lean();
const outputsOf = (detail: BatchDetail) => detail.items.flatMap((item) => item.outputs);

describe('cancel', () => {
  it('cancels a batch that has not started without touching the provider or Shopify', async () => {
    const batchId = await newBatch([0, 1]);
    const res = await client.post(`/api/v1/batches/${batchId}/cancel`);
    expect(res.status).toBe(200);
    expect(batchSummarySchema.parse(res.body)).toMatchObject({ status: 'cancelled', counts: { jobsTotal: 8, jobsCancelled: 8, jobsSucceeded: 0 } });

    const calls = e2e.stub.state.calls.length;
    for (let tick = 0; tick < 5; tick += 1) await e2e.tick();
    await e2e.settle();
    expect(e2e.stub.state.calls.length).toBe(calls);
    const detail = await getBatch(client, batchId);
    expect(detail.finishedAt).not.toBeNull();
    expect(detail.items.map((item) => item.status)).toEqual(['cancelled', 'cancelled']);
    expect(detail.items.flatMap((item) => item.jobs.map((job) => job.errorCode))).toEqual(Array(8).fill('cancelled'));

    // Cancelling again is harmless, a finished batch cannot be retried, and unknown ids are 404.
    expect((await client.post(`/api/v1/batches/${batchId}/cancel`)).status).toBe(200);
    expect((await client.post(`/api/v1/batches/${batchId}/retry-failed`)).status).toBe(400);
    expect((await client.post(`/api/v1/batches/${'f'.repeat(24)}/cancel`)).status).toBe(404);
  });

  it('keeps the outputs produced so far and cancels the rest of a running batch', async () => {
    e2e.editConfig((config) => {
      defined(config.lanes['fake:*']).maxConcurrent = 2;
    });
    const batchId = await newBatch([0, 1, 2]);
    const imagesDone = async (): Promise<boolean> => (await JobModel.countDocuments({ batchId, type: 'image', status: 'succeeded' })) >= 1;
    await e2e.drive(imagesDone, { timeoutMs: 30_000 });

    const cancelled = await client.post(`/api/v1/batches/${batchId}/cancel`);
    expect(cancelled.status).toBe(200);
    expect(batchSummarySchema.parse(cancelled.body).counts.jobsCancelled).toBeGreaterThan(0);

    // Jobs that were already running finish and keep their output; nothing new starts.
    await e2e.settle();
    for (let tick = 0; tick < 10; tick += 1) {
      await e2e.tick();
      await sleep(20);
    }
    await e2e.settle();
    const calls = e2e.stub.state.calls.length;
    for (let tick = 0; tick < 5; tick += 1) await e2e.tick();
    expect(e2e.stub.state.calls.length).toBe(calls);

    const detail = await getBatch(client, batchId);
    const jobs = await jobsOf(batchId);
    expect(detail.status).toBe('cancelled');
    expect(jobs.every((job) => ['succeeded', 'cancelled'].includes(job.status))).toBe(true);
    const succeededImages = jobs.filter((job) => job.type === 'image' && job.status === 'succeeded');
    expect(succeededImages.length).toBeGreaterThanOrEqual(1);
    expect(succeededImages.length).toBeLessThan(6);
    expect(jobs.filter((job) => job.status === 'cancelled').length).toBe(detail.counts.jobsCancelled);
    expect(detail.counts.jobsFailed).toBe(0);

    const images = outputsOf(detail).filter((output) => output.mediaType === 'image');
    expect(images).toHaveLength(succeededImages.length);
    expect(images.every((image) => image.status === 'ready' && image.url !== null)).toBe(true);
    expect(detail.counts.imagesReady).toBe(images.length);
    expect(new Set(detail.items.map((item) => item.status))).toContain('cancelled');
    // The cancelled jobs say so, and the batch cannot be retried.
    expect(detail.items.flatMap((item) => item.jobs).filter((job) => job.status === 'cancelled').every((job) => job.errorCode === 'cancelled')).toBe(true);
    expect((await client.post(`/api/v1/batches/${batchId}/retry-failed`)).status).toBe(400);
    expect(await MediaAssetModel.countDocuments({ batchId, role: 'output', status: 'ready' })).toBeGreaterThanOrEqual(images.length);
    e2e.editConfig((config) => {
      defined(config.lanes['fake:*']).maxConcurrent = 50;
    });
  }, 60_000);
});

describe('retry failed', () => {
  it('retries an output Shopify refused and completes the batch', async () => {
    e2e.stub.state.knobs.fileCreateRejection = (file) =>
      /^rs-oak-side-table-[0-9a-f]{6}-img2\.jpg$/.test(file.filename)
        ? [{ field: ['files', '0', 'originalSource'], message: 'The image could not be imported', code: 'INVALID' }]
        : undefined;
    const batchId = await newBatch([0, 1, 2]);
    const batch = await e2e.driveBatch(batchId, { timeoutMs: 60_000 });
    expect(batch.status).toBe('completed_with_errors');
    await e2e.settle();

    const detail = await getBatch(client, batchId);
    expect(detail.counts).toMatchObject({ jobsTotal: 12, jobsSucceeded: 11, jobsFailed: 1, imagesReady: 5, videosReady: 3 });
    expect(detail.items.map((item) => item.status)).toEqual(['completed', 'completed', 'partial']);
    const partial = defined(detail.items[2]);
    expect(partial.outputs).toHaveLength(2);
    expect(partial.jobs.find((job) => job.status === 'failed')).toMatchObject({ type: 'image', outputIndex: 1, errorCode: 'shopify_upload_failed' });

    const failedJob = defined(await JobModel.findOne({ batchId, status: 'failed' }).lean());
    expect(failedJob).toMatchObject({ attempts: 2, maxAttempts: 2, error: { code: 'shopify_upload_failed', retryable: false } });
    expect(await MediaAssetModel.findOne({ sourceJobId: failedJob._id }).lean()).toMatchObject({ status: 'failed', role: 'output' });

    // Shopify accepts the file now. Retrying requeues exactly the failed job, with its attempts reset.
    e2e.stub.state.knobs.fileCreateRejection = null;
    const retried = await client.post(`/api/v1/batches/${batchId}/retry-failed`);
    expect(retried.status).toBe(200);
    expect(batchSummarySchema.parse(retried.body)).toMatchObject({ status: 'running', finishedAt: null, counts: { jobsFailed: 0, jobsSucceeded: 11 } });
    expect(await JobModel.findById(failedJob._id).lean()).toMatchObject({ status: 'queued', attempts: 0 });
    expect(errorOf(await client.post(`/api/v1/batches/${batchId}/retry-failed`)).code).toBe('validation_failed');

    const finished = await e2e.driveBatch(batchId, { timeoutMs: 60_000 });
    expect(finished.status).toBe('completed');
    await e2e.settle();
    const after = await getBatch(client, batchId);
    expect(after.counts).toMatchObject({ jobsSucceeded: 12, jobsFailed: 0, imagesReady: 6, videosReady: 3 });
    expect(after.items.map((item) => item.status)).toEqual(['completed', 'completed', 'completed']);
    expect(defined(after.items[2]).outputs.map((output) => output.filename.replace(/^rs-oak-side-table-[0-9a-f]{6}-/, ''))).toEqual(['img1.jpg', 'img2.jpg', 'vid1.mp4']);

    // The recovered output reuses its media record: one record per job, now ready.
    expect(await MediaAssetModel.countDocuments({ sourceJobId: failedJob._id })).toBe(1);
    expect(await MediaAssetModel.findOne({ sourceJobId: failedJob._id }).lean()).toMatchObject({ status: 'ready' });
    expect(await JobModel.findById(failedJob._id).lean()).toMatchObject({ status: 'succeeded', attempts: 1 });
  }, 120_000);

  it('retries a product whose images could not be downloaded', async () => {
    e2e.stub.state.knobs.cdnNotFound = ['/products/brass-desk-lamp-'];
    const batchId = await newBatch([0, 3, 4]);
    const batch = await e2e.driveBatch(batchId, { timeoutMs: 60_000 });
    expect(batch.status).toBe('completed_with_errors');
    await e2e.settle();

    const detail = await getBatch(client, batchId);
    expect(detail.items.map((item) => [item.title, item.status])).toEqual([
      ['Ceramic Table Lamp', 'completed'],
      ['Brass Desk Lamp', 'failed'],
      ['Wool Blanket', 'completed'],
    ]);
    expect(defined(detail.items[1]).outputs).toEqual([]);
    expect(defined(detail.items[1]).jobs.every((job) => job.status === 'failed' && job.errorCode === 'transient')).toBe(true);
    expect(detail.counts).toMatchObject({ jobsFailed: 4, jobsSucceeded: 8 });
    // A failed planner never blocks the outputs of a product that can still be generated: its siblings are untouched.
    expect((await BatchItemModel.find({ batchId }).sort({ _id: 1 }).lean()).map((item) => item.planSource)).toEqual(['planner', 'fallback', 'planner']);

    e2e.stub.state.knobs.cdnNotFound = [];
    expect((await client.post(`/api/v1/batches/${batchId}/retry-failed`)).status).toBe(200);
    const finished = await e2e.driveBatch(batchId, { timeoutMs: 60_000 });
    expect(finished.status).toBe('completed');
    await e2e.settle();
    const after = await getBatch(client, batchId);
    expect(after.items.map((item) => item.status)).toEqual(['completed', 'completed', 'completed']);
    expect(defined(after.items[1]).outputs).toHaveLength(3);
  }, 120_000);
});

describe('Shopify revokes the token while a batch runs', () => {
  it('fails the outputs that cannot be stored and finishes them after the merchant logs in again', async () => {
    const batchId = await newBatch([0]);
    e2e.stub.revokeTokens(SHOP);
    const batch = await e2e.driveBatch(batchId, { timeoutMs: 60_000 });
    expect(batch.status).toBe('failed');
    await e2e.settle();

    const jobs = await jobsOf(batchId);
    expect(jobs.filter((job) => job.type === 'plan').every((job) => job.status === 'succeeded')).toBe(true);
    const outputs = jobs.filter((job) => job.type !== 'plan');
    expect(outputs.every((job) => job.status === 'failed' && job.error?.code === 'shopify_upload_failed')).toBe(true);
    expect(await MediaAssetModel.countDocuments({ batchId, status: 'ready' })).toBe(0);

    // The app is sent back to login; the shop needs a new offline token.
    expect((await client.get(`/api/v1/batches/${batchId}`)).status).toBe(409);
    client = await login(e2e, SHOP);
    const detail = await getBatch(client, batchId);
    expect(detail.counts).toMatchObject({ jobsFailed: 3, jobsSucceeded: 1 });

    expect((await client.post(`/api/v1/batches/${batchId}/retry-failed`)).status).toBe(200);
    expect((await e2e.driveBatch(batchId, { timeoutMs: 60_000 })).status).toBe('completed');
    await e2e.settle();
    const after = await getBatch(client, batchId);
    expect(after.items[0]?.outputs).toHaveLength(3);
    expect(after.items[0]?.outputs.every((output) => output.status === 'ready')).toBe(true);
  }, 120_000);
});

describe('logs', () => {
  it('only warns about dropped or retried work', () => {
    const expected = [
      'outcome dropped: the job is no longer owned by this runner',
      'persisting an output failed',
      'fileCreate rejected the upload',
      'shop requires re-authorization',
      'released blocked jobs whose dependencies were already terminal',
    ];
    expect(e2e.problems(expected)).toEqual([]);
  });
});
