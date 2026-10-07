import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { JobStatus } from '@rs/shared';
import type { JobStore } from '../../src/modules/queue';
import { JobModel } from '../../src/modules/queue/models';
import { MONGO_START_TIMEOUT_MS, startTestMongo, type TestMongo } from '../helpers/mongo';
import { createClock, createRig, insertJob, objectId, reloadJob, START, type Rig } from './kit';

let mongo: TestMongo;
let rig: Rig;
let store: JobStore;

beforeAll(async () => {
  mongo = await startTestMongo('rs_queue_store');
}, MONGO_START_TIMEOUT_MS);

afterAll(async () => {
  await mongo.stop();
});

beforeEach(async () => {
  await mongo.clear();
  rig = createRig({ clock: createClock() });
  store = rig.module.store;
});

const ids = () => ({ shopId: objectId(), batchId: objectId(), batchItemId: objectId() });

describe('indexes (SPEC 14.9)', () => {
  it('creates every index of the jobs collection', async () => {
    await rig.module.ensureIndexes();
    const keys = (await JobModel.collection.indexes()).map((index) => JSON.stringify(index.key));
    expect(keys).toEqual(
      expect.arrayContaining([
        JSON.stringify({ status: 1, lane: 1, runAt: 1, priority: -1 }),
        JSON.stringify({ status: 1, 'operation.nextPollAt': 1 }),
        JSON.stringify({ status: 1, 'lease.expiresAt': 1 }),
        JSON.stringify({ batchId: 1 }),
        JSON.stringify({ batchItemId: 1 }),
        JSON.stringify({ shopId: 1, createdAt: 1 }),
      ]),
    );
  });
});

describe('enqueue', () => {
  it('creates a queued job runnable now, with maxAttempts from config', async () => {
    const job = await store.enqueue({ ...ids(), type: 'plan', lane: 'vertex:gemini-2.5-flash' });
    expect(job).toMatchObject({
      type: 'plan',
      lane: 'vertex:gemini-2.5-flash',
      status: 'queued',
      dependsOn: [],
      outputIndex: null,
      priority: 0,
      attempts: 0,
      maxAttempts: 3,
      deferrals: 0,
      operation: null,
      error: null,
      startedAt: null,
      finishedAt: null,
    });
    expect(job.runAt.toISOString()).toBe(START);
    expect(job.createdAt.toISOString()).toBe(START);
  });

  it('starts blocked when dependsOn is not empty and keeps outputIndex, priority and dependencies', async () => {
    const common = ids();
    const plan = await store.enqueue({ ...common, type: 'plan', lane: 'l' });
    const image = await store.enqueue({ ...common, type: 'image', lane: 'l', dependsOn: [plan.id], outputIndex: 1, priority: 5 });
    expect(image).toMatchObject({ status: 'blocked', dependsOn: [plan.id], outputIndex: 1, priority: 5 });
  });

  it('snapshots the live queue.maxAttempts at enqueue time', async () => {
    rig.cfg.queue = { ...rig.cfg.queue, maxAttempts: 5 };
    expect((await store.enqueue({ ...ids(), type: 'plan', lane: 'l' })).maxAttempts).toBe(5);
  });

  it('get returns the job, or null for unknown and malformed ids', async () => {
    const job = await store.enqueue({ ...ids(), type: 'plan', lane: 'l' });
    expect((await store.get(job.id))?.id).toBe(job.id);
    expect(await store.get(objectId())).toBeNull();
    expect(await store.get('not-an-id')).toBeNull();
  });

  it('listByBatch is scoped to the shop and batch, oldest first', async () => {
    const mine = ids();
    const other = ids();
    const a = await store.enqueue({ ...mine, type: 'plan', lane: 'l' });
    const b = await store.enqueue({ ...mine, type: 'image', lane: 'l', dependsOn: [a.id] });
    await store.enqueue({ ...other, type: 'plan', lane: 'l' });
    await store.enqueue({ ...mine, batchId: objectId(), type: 'plan', lane: 'l' });
    await store.enqueue({ ...mine, shopId: objectId(), type: 'plan', lane: 'l' });

    const listed = await store.listByBatch(mine.shopId, mine.batchId);
    expect(listed.map((job) => job.id)).toEqual([a.id, b.id]);
  });
});

describe('cancelByBatch', () => {
  it('cancels blocked, queued and awaiting_operation jobs only, and leaves running and finished jobs', async () => {
    const batch = ids();
    const statuses: JobStatus[] = ['blocked', 'queued', 'awaiting_operation', 'running', 'succeeded', 'failed', 'cancelled'];
    const docs = await Promise.all(statuses.map((status) => insertJob({ ...batch, status })));
    const otherBatch = await insertJob({ ...batch, batchId: objectId(), status: 'queued' });
    const otherShop = await insertJob({ batchId: batch.batchId, status: 'queued' });

    expect(await store.cancelByBatch(batch.shopId, batch.batchId)).toBe(3);

    const after = await Promise.all(docs.map((doc) => reloadJob(doc._id)));
    expect(after.map((doc) => doc.status)).toEqual([
      'cancelled',
      'cancelled',
      'cancelled',
      'running',
      'succeeded',
      'failed',
      'cancelled',
    ]);
    expect(after[0]?.error?.code).toBe('cancelled');
    expect(after[0]?.finishedAt?.toISOString()).toBe(START);
    expect((await reloadJob(otherBatch._id)).status).toBe('queued');
    expect((await reloadJob(otherShop._id)).status).toBe('queued');
  });

  it('clears the lease of an awaiting_operation job that was being polled', async () => {
    const batch = ids();
    const doc = await insertJob({
      ...batch,
      status: 'awaiting_operation',
      lease: { owner: 'x', expiresAt: new Date('2026-10-07T13:00:00Z') },
    });
    await store.cancelByBatch(batch.shopId, batch.batchId);
    expect((await reloadJob(doc._id)).lease).toBeUndefined();
  });

  it('is idempotent', async () => {
    const batch = ids();
    await insertJob({ ...batch, status: 'queued' });
    expect(await store.cancelByBatch(batch.shopId, batch.batchId)).toBe(1);
    expect(await store.cancelByBatch(batch.shopId, batch.batchId)).toBe(0);
  });
});

describe('cancelByShop', () => {
  it('cancels every non-terminal job of the shop, running included, and no other shop', async () => {
    const shopId = objectId();
    const live: JobStatus[] = ['blocked', 'queued', 'running', 'awaiting_operation'];
    const mine = await Promise.all(live.map((status) => insertJob({ shopId, status })));
    const done = await insertJob({ shopId, status: 'succeeded' });
    const other = await insertJob({ status: 'queued' });

    expect(await store.cancelByShop(shopId)).toBe(4);
    for (const doc of mine) expect((await reloadJob(doc._id)).status).toBe('cancelled');
    expect((await reloadJob(done._id)).status).toBe('succeeded');
    expect((await reloadJob(other._id)).status).toBe('queued');
  });
});

describe('requeueFailed', () => {
  it('requeues failed jobs with attempts reset and the failure cleared, nothing else', async () => {
    const batch = ids();
    const failed = await insertJob({ ...batch, status: 'failed', attempts: 3 });
    await JobModel.updateOne(
      { _id: failed._id },
      {
        $set: { deferrals: 4, finishedAt: new Date(START), error: { code: 'transient', message: 'boom', retryable: true, at: new Date(START) } },
      },
    );
    const cancelled = await insertJob({ ...batch, status: 'cancelled' });
    const succeeded = await insertJob({ ...batch, status: 'succeeded' });
    const otherBatch = await insertJob({ ...batch, batchId: objectId(), status: 'failed' });

    rig.clock.advance(3_600_000);
    expect(await store.requeueFailed(batch.shopId, batch.batchId)).toBe(1);

    const after = await reloadJob(failed._id);
    expect(after).toMatchObject({ status: 'queued', attempts: 0, deferrals: 0 });
    expect(after.runAt.toISOString()).toBe('2026-10-07T13:00:00.000Z');
    expect(after.requeuedAt?.toISOString()).toBe('2026-10-07T13:00:00.000Z');
    expect(after.error).toBeUndefined();
    expect(after.finishedAt).toBeUndefined();
    expect((await reloadJob(cancelled._id)).status).toBe('cancelled');
    expect((await reloadJob(succeeded._id)).status).toBe('succeeded');
    expect((await reloadJob(otherBatch._id)).status).toBe('failed');
  });
});

describe('purgeShop', () => {
  it('deletes every job of the shop and only those', async () => {
    const shopId = objectId();
    await insertJob({ shopId, status: 'queued' });
    await insertJob({ shopId, status: 'succeeded' });
    const other = await insertJob({ status: 'queued' });

    await store.purgeShop(shopId);
    expect(await JobModel.countDocuments({ shopId })).toBe(0);
    expect(await JobModel.countDocuments()).toBe(1);
    expect((await reloadJob(other._id)).status).toBe('queued');
  });
});
