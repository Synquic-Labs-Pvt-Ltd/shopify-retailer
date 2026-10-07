import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { batchSummarySchema, healthResponseSchema, type MediaObject } from '@rs/shared';
import { FAKE_JPEG } from '../../src/modules/ai/fake-media';
import { BatchModel } from '../../src/modules/batches/models';
import { JobModel } from '../../src/modules/queue/models';
import { commonImageSpec, createBatch, defined, getBatch, login, uploadReadyReferences, type ApiClient } from './support/client';
import { MONGO_START_TIMEOUT_MS, startE2e, type E2e } from './support/harness';
import { waitFor } from './support/wait';

const SHOP = 'defaults-store.myshopify.com';

let e2e: E2e;
let client: ApiClient;
let reference: MediaObject;

beforeAll(async () => {
  e2e = await startE2e({ dbName: 'rs_e2e_defaults', shippedTimings: true });
  e2e.stub.addShop(SHOP);
  client = await login(e2e, SHOP);
  reference = defined((await uploadReadyReferences(client, [commonImageSpec('common', FAKE_JPEG)]))[0]);
}, MONGO_START_TIMEOUT_MS);

afterAll(async () => {
  await e2e.container.queue.runner.stop();
  await e2e.stop();
});

describe('the shipped queue settings and lanes with the timer driven runner', () => {
  it('finish a batch of two products with the fake provider, 3 s of latency and 15 s video polls', async () => {
    const products = e2e.stub.shop(SHOP).products;
    const res = await createBatch(client, {
      products: [{ productGid: defined(products[0]).id }, { productGid: defined(products[1]).id }],
      commonReferenceMediaIds: [reference.id],
    });
    const batchId = batchSummarySchema.parse(res.body).id;

    e2e.container.queue.runner.start();
    const started = Date.now();
    const done = await waitFor(
      async () => {
        const batch = await BatchModel.findById(batchId).lean();
        return batch !== null && ['completed', 'completed_with_errors', 'failed'].includes(batch.status) ? batch : null;
      },
      { timeoutMs: 150_000, intervalMs: 500, label: 'the batch to finish' },
    );
    await e2e.container.queue.runner.stop();
    const seconds = (Date.now() - started) / 1000;

    expect(done.status).toBe('completed');
    // Planning and images take a few seconds; the video needs two polls 15 s apart plus its upload.
    expect(seconds).toBeGreaterThan(30);
    expect(seconds).toBeLessThan(90);
    const detail = await getBatch(client, batchId);
    expect(detail.counts).toMatchObject({ jobsSucceeded: 8, imagesReady: 4, videosReady: 2 });
    const jobs = await JobModel.find({ batchId }).lean();
    expect(jobs.every((job) => job.attempts === 1 && job.deferrals === 0)).toBe(true);
    expect(healthResponseSchema.parse((await request(e2e.app).get('/health')).body).pausedLanes).toEqual([]);
    expect(e2e.problems(['released blocked jobs whose dependencies were already terminal'])).toEqual([]);
  }, 200_000);
});
