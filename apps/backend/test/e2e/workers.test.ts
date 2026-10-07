import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { batchSummarySchema, healthResponseSchema, type MediaObject } from '@rs/shared';
import { FAKE_JPEG } from '../../src/modules/ai/fake-media';
import type { Container } from '../../src/container';
import { BatchModel } from '../../src/modules/batches/models';
import { MediaAssetModel } from '../../src/modules/media/models';
import { JobModel } from '../../src/modules/queue/models';
import { commonImageSpec, createBatch, defined, getBatch, login, uploadReadyReferences, type ApiClient } from './support/client';
import { MONGO_START_TIMEOUT_MS, startE2e, type E2e } from './support/harness';
import { sleep, waitFor } from './support/wait';

const SHOP = 'workers-store.myshopify.com';

let e2e: E2e;
let client: ApiClient;
let reference: MediaObject;
let gids: string[] = [];

beforeAll(async () => {
  e2e = await startE2e({
    dbName: 'rs_e2e_workers',
    config: (config) => {
      config.batch.maxActiveBatchesPerShop = 100;
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

const isTerminal = async (batchId: string): Promise<boolean> => {
  const batch = await BatchModel.findById(batchId).lean();
  return batch !== null && ['completed', 'completed_with_errors', 'failed', 'cancelled'].includes(batch.status);
};

describe('two workers on one database', () => {
  it('never run a job twice', async () => {
    e2e.editConfig((config) => {
      config.fake.latencyMs = 30;
      defined(config.lanes['fake:*']).maxConcurrent = 3;
    });
    const second: Container = e2e.secondInstance();
    const batches = [await newBatch([0, 1]), await newBatch([2, 3])];

    const owners = new Set<string>();
    const both = async (): Promise<boolean> => {
      for (const owner of await JobModel.distinct('lease.owner', { status: 'running' })) owners.add(String(owner));
      return (await Promise.all(batches.map(isTerminal))).every(Boolean);
    };
    await e2e.drive(both, { timeoutMs: 90_000, intervalMs: 5, runners: [e2e.container, second] });
    await Promise.all([e2e.settle(), second.queue.runner.idle()]);

    for (const batchId of batches) expect((await BatchModel.findById(batchId).lean())?.status).toBe('completed');
    const jobs = await JobModel.find({ batchId: { $in: batches } }).lean();
    expect(jobs).toHaveLength(16);
    expect(jobs.every((job) => job.status === 'succeeded' && job.attempts === 1 && job.deferrals === 0)).toBe(true);

    // Each output exists once, in the database and in the Shopify store.
    const outputs = await MediaAssetModel.find({ batchId: { $in: batches }, role: 'output' }).lean();
    expect(outputs).toHaveLength(12);
    expect(new Set(outputs.map((output) => String(output.sourceJobId))).size).toBe(12);
    expect(new Set(outputs.map((output) => output.shopify?.fileGid)).size).toBe(12);
    expect(e2e.stub.shop(SHOP).files.size).toBe(1 + 12);
    expect(e2e.stub.state.calls.filter((call) => call.kind === 'staged_upload')).toHaveLength(1 + 12);
    expect(owners.size).toBeGreaterThanOrEqual(1);
  }, 120_000);

  it('recovers, with a restarted worker, the jobs a dead worker was holding', async () => {
    e2e.editConfig((config) => {
      config.fake.latencyMs = 0;
      defined(config.lanes['fake:*']).maxConcurrent = 50;
    });
    const batchId = await newBatch([4]);
    await e2e.tick();
    await e2e.settle();
    const images = await JobModel.find({ batchId, type: 'image' }).sort({ outputIndex: 1 }).lean();
    expect(images.map((job) => job.status)).toEqual(['queued', 'queued']);

    // The first worker died while running both image jobs: one still has attempts left, the other does not.
    const dead = (attempts: number) => ({ status: 'running', attempts, startedAt: new Date(), lease: { owner: 'dead-worker:1', expiresAt: new Date(Date.now() - 60_000) } });
    await JobModel.updateOne({ _id: defined(images[0])._id }, { $set: dead(1) });
    await JobModel.updateOne({ _id: defined(images[1])._id }, { $set: dead(3) });

    // A fresh runner reaps on its first tick.
    const restarted = e2e.secondInstance();
    await e2e.drive(() => isTerminal(batchId), { timeoutMs: 60_000, runners: [restarted] });
    await restarted.queue.runner.idle();

    const [recovered, exhausted] = await Promise.all(images.map((job) => JobModel.findById(job._id).lean()));
    expect(recovered).toMatchObject({ status: 'succeeded', attempts: 2 });
    expect(exhausted).toMatchObject({ status: 'failed', attempts: 3, error: { code: 'lease_expired', retryable: false } });

    const detail = await getBatch(client, batchId);
    expect(detail.status).toBe('completed_with_errors');
    expect(detail.items[0]?.status).toBe('partial');
    expect(detail.items[0]?.jobs.map((job) => [job.type, job.outputIndex, job.status, job.errorCode])).toEqual([
      ['plan', null, 'succeeded', null],
      ['image', 0, 'succeeded', null],
      ['image', 1, 'failed', 'lease_expired'],
      ['video', 0, 'succeeded', null],
    ]);
    expect(detail.items[0]?.outputs).toHaveLength(2);
    expect(e2e.logs.filter((line) => line.includes('reaped a job with an expired lease'))).toHaveLength(2);
  }, 90_000);
});

describe('the timer driven runner', () => {
  it('ticks by itself, stops gracefully with jobs in flight and picks up where it stopped', async () => {
    const runner = e2e.container.queue.runner;
    const batchId = await newBatch([0, 1]);
    runner.start();
    try {
      await waitFor(async () => (await JobModel.countDocuments({ batchId, type: 'image', status: 'running' })) > 0, { timeoutMs: 20_000, label: 'an image job to start' });
      const beforeStop = e2e.container.queue.runner.lastTickAt;
      expect(beforeStop).toBeInstanceOf(Date);

      await runner.stop();
      // Whatever was running finished (or went back to the queue); nothing is left holding a lease.
      expect(await JobModel.countDocuments({ batchId, status: 'running' })).toBe(0);
      expect(await isTerminal(batchId)).toBe(false);
      const claimed = await JobModel.countDocuments({ batchId, startedAt: { $exists: true } });
      await sleep(300);
      expect(await JobModel.countDocuments({ batchId, startedAt: { $exists: true } })).toBe(claimed);
      expect(await JobModel.countDocuments({ batchId, status: 'succeeded' })).toBeGreaterThan(2);

      runner.start();
      await waitFor(() => isTerminal(batchId), { timeoutMs: 60_000, intervalMs: 100, label: 'the batch to finish' });
    } finally {
      await runner.stop();
    }

    expect((await BatchModel.findById(batchId).lean())?.status).toBe('completed');
    const health = healthResponseSchema.parse((await request(e2e.app).get('/health')).body);
    expect(Date.now() - new Date(defined(health.worker.lastTickAt)).getTime()).toBeLessThan(5_000);
    expect(e2e.problems(['reaped a job with an expired lease', 'released blocked jobs whose dependencies were already terminal'])).toEqual([]);
  }, 120_000);
});
