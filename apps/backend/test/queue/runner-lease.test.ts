import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { JobError, JobOutcome } from '../../src/modules/queue';
import { JobModel } from '../../src/modules/queue/models';
import { MONGO_START_TIMEOUT_MS, startTestMongo, type TestMongo } from '../helpers/mongo';
import {
  createRig,
  deferred,
  handlerFor,
  insertJob,
  objectId,
  openLane,
  reloadJob,
  START,
  tickAndSettle,
  waitFor,
  type Rig,
} from './kit';

let mongo: TestMongo;

beforeAll(async () => {
  mongo = await startTestMongo('rs_queue_lease');
}, MONGO_START_TIMEOUT_MS);

afterAll(async () => {
  await mongo.stop();
});

beforeEach(async () => {
  await mongo.clear();
});

const LANE = 'test:img';
const at = (offsetMs: number): Date => new Date(new Date(START).getTime() + offsetMs);
const failure: JobError = { code: 'invalid_request', message: 'bad', retryable: false };

describe('lease heartbeat', () => {
  it('extends the lease of a running job every leaseMs/3', async () => {
    const rig = createRig({ lanes: { [LANE]: openLane() } });
    rig.cfg.queue = { ...rig.cfg.queue, leaseMs: 300 };
    const gate = deferred<void>();
    rig.module.runner.registerHandler(
      handlerFor('image', async () => {
        await gate.promise;
        return { kind: 'succeeded' };
      }),
    );
    const job = await insertJob({ lane: LANE });

    await rig.module.runner.tickOnce();
    expect((await reloadJob(job._id)).lease?.expiresAt?.toISOString()).toBe(at(300).toISOString());

    rig.clock.advance(10_000);
    await waitFor(async () => (await reloadJob(job._id)).lease?.expiresAt?.getTime() === rig.clock.now().getTime() + 300);

    gate.resolve();
    await rig.module.runner.idle();
    expect((await reloadJob(job._id)).status).toBe('succeeded');
  });
});

describe('reaper', () => {
  const expired = { owner: 'dead-worker', expiresAt: at(-1000) };

  it('requeues an expired job with backoff while attempts remain, then another worker finishes it', async () => {
    const rig = createRig({ lanes: { [LANE]: openLane() } });
    let seenAttempts = 0;
    rig.module.runner.registerHandler(
      handlerFor('image', async (job) => {
        seenAttempts = job.attempts;
        return { kind: 'succeeded' };
      }),
    );
    const job = await insertJob({ lane: LANE, status: 'running', attempts: 1, lease: expired });

    await tickAndSettle(rig);

    const requeued = await reloadJob(job._id);
    expect(requeued).toMatchObject({ status: 'queued', attempts: 1 });
    expect(requeued.runAt.toISOString()).toBe(at(5000).toISOString());
    expect(requeued.error).toMatchObject({ code: 'lease_expired', retryable: true });
    expect(requeued.lease).toBeUndefined();
    expect(rig.terminals).toEqual([]);

    rig.clock.advance(5000);
    await tickAndSettle(rig);
    expect(seenAttempts).toBe(2);
    expect((await reloadJob(job._id)).status).toBe('succeeded');
  });

  it('applies exponential backoff by attempt count', async () => {
    const rig = createRig();
    const second = await insertJob({ lane: LANE, status: 'running', attempts: 2, lease: expired });
    await tickAndSettle(rig);
    expect((await reloadJob(second._id)).runAt.toISOString()).toBe(at(10_000).toISOString());
  });

  it('fails the job with lease_expired when attempts are exhausted, and notifies onTerminal', async () => {
    const rig = createRig();
    const job = await insertJob({ lane: LANE, status: 'running', attempts: 3, maxAttempts: 3, lease: expired });

    await tickAndSettle(rig);

    const doc = await reloadJob(job._id);
    expect(doc.status).toBe('failed');
    expect(doc.error).toMatchObject({ code: 'lease_expired', retryable: false });
    expect(doc.finishedAt?.toISOString()).toBe(START);
    expect(rig.terminals.map((t) => [t.id, t.status, t.error?.code])).toEqual([[job._id.toHexString(), 'failed', 'lease_expired']]);
  });

  it('releases the dependents of a job it failed', async () => {
    const rig = createRig();
    const batchItemId = objectId();
    const plan = await insertJob({ batchItemId, status: 'running', attempts: 3, lease: expired });
    const image = await insertJob({ batchItemId, status: 'blocked', dependsOn: [plan._id.toHexString()] });

    await tickAndSettle(rig);

    expect((await reloadJob(plan._id)).status).toBe('failed');
    expect((await reloadJob(image._id)).status).toBe('queued');
  });

  it('leaves a job with a live lease alone', async () => {
    const rig = createRig();
    const job = await insertJob({ lane: LANE, status: 'running', attempts: 1, lease: { owner: 'busy', expiresAt: at(60_000) } });
    await tickAndSettle(rig);
    expect(await reloadJob(job._id)).toMatchObject({ status: 'running', attempts: 1 });
  });

  it('runs every 30 seconds, and immediately on the first tick', async () => {
    const rig = createRig();
    await tickAndSettle(rig);

    const job = await insertJob({ lane: LANE, status: 'running', attempts: 1, lease: expired });
    rig.clock.advance(10_000);
    await tickAndSettle(rig);
    expect((await reloadJob(job._id)).status).toBe('running');

    rig.clock.advance(20_000);
    await tickAndSettle(rig);
    expect((await reloadJob(job._id)).status).toBe('queued');
  });

  it('repairs a blocked job whose dependencies are already terminal, and keeps waiting on live ones', async () => {
    const rig = createRig();
    const batchItemId = objectId();
    const done = await insertJob({ batchItemId, status: 'succeeded' });
    const live = await insertJob({ batchItemId, status: 'running', lease: { owner: 'busy', expiresAt: at(60_000) } });
    const orphan = await insertJob({ batchItemId, status: 'blocked', dependsOn: [done._id.toHexString()] });
    const waiting = await insertJob({ batchItemId, status: 'blocked', dependsOn: [done._id.toHexString(), live._id.toHexString()] });

    await tickAndSettle(rig);

    expect((await reloadJob(orphan._id)).status).toBe('queued');
    expect((await reloadJob(waiting._id)).status).toBe('blocked');
  });
});

describe('dependency release', () => {
  async function plan(rig: Rig) {
    const ids = { shopId: objectId(), batchId: objectId(), batchItemId: objectId() };
    const planJob = await rig.module.store.enqueue({ ...ids, type: 'plan', lane: 'test:plan' });
    const dependsOn = [planJob.id];
    const image0 = await rig.module.store.enqueue({ ...ids, type: 'image', lane: LANE, dependsOn, outputIndex: 0 });
    const image1 = await rig.module.store.enqueue({ ...ids, type: 'image', lane: LANE, dependsOn, outputIndex: 1 });
    const video = await rig.module.store.enqueue({ ...ids, type: 'video', lane: 'test:vid', dependsOn, outputIndex: 0 });
    return { ids, planJob, dependents: [image0, image1, video] };
  }

  const statusesOf = async (jobs: Array<{ id: string }>) => Promise.all(jobs.map(async (job) => (await reloadJob(job.id)).status));

  function rigWithPlan(outcome: () => JobOutcome): Rig {
    const rig = createRig({ lanes: { 'test:plan': openLane(), [LANE]: openLane(), 'test:vid': openLane() } });
    rig.module.runner.registerHandler(handlerFor('plan', async () => outcome()));
    return rig;
  }

  it('keeps dependents blocked until the plan job is terminal, then queues them for now', async () => {
    const rig = rigWithPlan(() => ({ kind: 'succeeded' }));
    const { planJob, dependents } = await plan(rig);
    expect(await statusesOf(dependents)).toEqual(['blocked', 'blocked', 'blocked']);

    await tickAndSettle(rig);

    expect((await reloadJob(planJob.id)).status).toBe('succeeded');
    expect(await statusesOf(dependents)).toEqual(['queued', 'queued', 'queued']);
    for (const dependent of dependents) expect((await reloadJob(dependent.id)).runAt.toISOString()).toBe(START);
  });

  it('a failed plan still releases its dependents', async () => {
    const rig = rigWithPlan(() => ({ kind: 'failed', error: failure }));
    const { planJob, dependents } = await plan(rig);
    await tickAndSettle(rig);
    expect((await reloadJob(planJob.id)).status).toBe('failed');
    expect(await statusesOf(dependents)).toEqual(['queued', 'queued', 'queued']);
  });

  it('a plan that fails only after exhausting retries releases its dependents then, not before', async () => {
    const rig = rigWithPlan(() => ({ kind: 'retry', error: { code: 'transient', message: 'x', retryable: true } }));
    const { planJob, dependents } = await plan(rig);

    await tickAndSettle(rig);
    expect((await reloadJob(planJob.id)).status).toBe('queued');
    expect(await statusesOf(dependents)).toEqual(['blocked', 'blocked', 'blocked']);

    for (let i = 0; i < 2; i += 1) {
      rig.clock.advance(60_000);
      await tickAndSettle(rig);
    }
    expect((await reloadJob(planJob.id)).status).toBe('failed');
    expect(await statusesOf(dependents)).toEqual(['queued', 'queued', 'queued']);
  });

  it('a cancelled plan releases its dependents too', async () => {
    const rig = rigWithPlan(() => ({ kind: 'cancelled' }));
    const { dependents } = await plan(rig);
    await tickAndSettle(rig);
    expect(await statusesOf(dependents)).toEqual(['queued', 'queued', 'queued']);
  });

  it('a job with several dependencies is released only when all are terminal', async () => {
    const rig = createRig({ lanes: { [LANE]: openLane(), 'test:vid': openLane() } });
    const batchItemId = objectId();
    const a = await insertJob({ batchItemId, lane: LANE });
    const b = await insertJob({ batchItemId, lane: LANE, runAt: at(60_000) });
    const waiting = await insertJob({
      batchItemId,
      type: 'video',
      lane: 'test:vid',
      status: 'blocked',
      dependsOn: [a._id.toHexString(), b._id.toHexString()],
    });
    rig.module.runner.registerHandler(
      handlerFor('image', async (job) =>
        job.id === a._id.toHexString() ? { kind: 'succeeded' } : { kind: 'failed', error: failure },
      ),
    );

    await tickAndSettle(rig);
    expect((await reloadJob(a._id)).status).toBe('succeeded');
    expect((await reloadJob(waiting._id)).status).toBe('blocked');

    rig.clock.advance(60_000);
    await tickAndSettle(rig);
    expect((await reloadJob(b._id)).status).toBe('failed');
    expect((await reloadJob(waiting._id)).status).toBe('queued');
  });

  it('releases dependents before onTerminal runs, so aggregation sees a consistent queue', async () => {
    const seen: string[] = [];
    const rig = createRig({
      lanes: { 'test:plan': openLane(), [LANE]: openLane() },
      onTerminal: async (job) => {
        if (job.type !== 'plan') return;
        const dependents = await JobModel.find({ batchItemId: job.batchItemId, type: 'image' }).lean();
        seen.push(...dependents.map((d) => d.status));
      },
    });
    rig.module.runner.registerHandler(handlerFor('plan', async () => ({ kind: 'succeeded' })));
    const ids = { shopId: objectId(), batchId: objectId(), batchItemId: objectId() };
    const planJob = await rig.module.store.enqueue({ ...ids, type: 'plan', lane: 'test:plan' });
    await rig.module.store.enqueue({ ...ids, type: 'image', lane: LANE, dependsOn: [planJob.id] });

    await tickAndSettle(rig);
    expect(seen).toEqual(['queued']);
  });

  it('then runs the released jobs on the next tick, plan before images', async () => {
    const rig = createRig({ lanes: { 'test:plan': openLane(), [LANE]: openLane(), 'test:vid': openLane() } });
    const order: string[] = [];
    rig.module.runner.registerHandler(
      handlerFor('plan', async () => {
        order.push('plan');
        return { kind: 'succeeded' };
      }),
    );
    rig.module.runner.registerHandler(
      handlerFor('image', async (job) => {
        order.push(`image${job.outputIndex}`);
        return { kind: 'succeeded' };
      }),
    );
    await plan(rig);

    await tickAndSettle(rig);
    await tickAndSettle(rig);

    expect(order).toEqual(['plan', 'image0', 'image1']);
  });
});
