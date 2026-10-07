import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { JobError, JobOutcome, QueueJob } from '../../src/modules/queue';
import { JobModel } from '../../src/modules/queue/models';
import { RateCounterModel } from '../../src/modules/ratelimit/models';
import { MONGO_START_TIMEOUT_MS, startTestMongo, type TestMongo } from '../helpers/mongo';
import {
  createClock,
  createConfigHolder,
  createRig,
  createStubGovernor,
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
  type RigOptions,
} from './kit';

let mongo: TestMongo;

beforeAll(async () => {
  mongo = await startTestMongo('rs_queue_poll');
}, MONGO_START_TIMEOUT_MS);

afterAll(async () => {
  await mongo.stop();
});

beforeEach(async () => {
  await mongo.clear();
});

const LANE = 'test:vid';
const POLL = 'test:poll';
const POLL_EVERY = 15_000;
const at = (offsetMs: number): Date => new Date(new Date(START).getTime() + offsetMs);
const lanes = { [LANE]: openLane({ pollLane: POLL, rpm: 10 }), [POLL]: openLane({ rpm: 60 }) };

const submitted = (rig: Rig): JobOutcome => ({
  kind: 'awaiting_operation',
  operation: { name: 'operations/op-1', nextPollAt: new Date(rig.clock.now().getTime() + POLL_EVERY) },
  audit: { promptVersion: 'v1', renderedPrompt: 'prompt' },
});

interface PollContext {
  rig: Rig;
  job: QueueJob;
  poll: number;
}

interface VideoRig {
  rig: Rig;
  runs: QueueJob[];
  polls: QueueJob[];
}

// A video handler that submits once and answers each poll through `pollOutcome`.
function videoRig(pollOutcome: (ctx: PollContext) => JobOutcome | Promise<JobOutcome>, options: RigOptions = {}): VideoRig {
  const rig = createRig({ lanes, ...options });
  const runs: QueueJob[] = [];
  const polls: QueueJob[] = [];
  rig.module.runner.registerHandler(
    handlerFor(
      'video',
      async (job) => {
        runs.push(job);
        return submitted(rig);
      },
      async (job) => {
        polls.push(job);
        return pollOutcome({ rig, job, poll: polls.length });
      },
    ),
  );
  return { rig, runs, polls };
}

const enqueueVideo = (rig: Rig, shopId = objectId()) =>
  rig.module.store.enqueue({ shopId, batchId: objectId(), batchItemId: objectId(), type: 'video', lane: LANE, outputIndex: 0 });

const pending = (rig: Rig): JobOutcome => ({
  kind: 'awaiting_operation',
  operation: { name: 'operations/op-1', nextPollAt: new Date(rig.clock.now().getTime() + POLL_EVERY) },
});

const tokens = async (lane: string): Promise<number> =>
  (await RateCounterModel.find({ lane, window: 'minute' }).lean()).reduce((sum, doc) => sum + doc.count, 0);

describe('poll cycle', () => {
  it('submit releases the worker slot, then polls on schedule until the operation finishes', async () => {
    const { rig, runs, polls } = videoRig(({ rig: r, poll }) =>
      poll < 3 ? pending(r) : { kind: 'succeeded', output: { mediaAssetId: objectId(), providerResponseId: 'op-1', modelVersion: 'veo' } },
    );
    const job = await enqueueVideo(rig);

    await tickAndSettle(rig);

    let doc = await reloadJob(job.id);
    expect(doc).toMatchObject({ status: 'awaiting_operation', attempts: 1, promptVersion: 'v1' });
    expect(doc.operation).toMatchObject({ name: 'operations/op-1', polls: 0 });
    expect(doc.operation?.submittedAt?.toISOString()).toBe(START);
    expect(doc.operation?.nextPollAt?.toISOString()).toBe(at(POLL_EVERY).toISOString());
    expect(doc.lease).toBeUndefined();
    expect(runs).toHaveLength(1);
    expect(await tokens(LANE)).toBe(1);

    rig.clock.advance(POLL_EVERY - 1);
    await tickAndSettle(rig);
    expect(polls).toHaveLength(0);

    rig.clock.advance(1);
    await tickAndSettle(rig);
    doc = await reloadJob(job.id);
    expect(polls).toHaveLength(1);
    expect(polls[0]?.operation?.name).toBe('operations/op-1');
    expect(doc).toMatchObject({ status: 'awaiting_operation' });
    expect(doc.operation?.polls).toBe(1);
    expect(doc.operation?.nextPollAt?.toISOString()).toBe(at(2 * POLL_EVERY).toISOString());
    expect(doc.lease).toBeUndefined();

    rig.clock.advance(POLL_EVERY);
    await tickAndSettle(rig);
    rig.clock.advance(POLL_EVERY);
    await tickAndSettle(rig);

    doc = await reloadJob(job.id);
    expect(polls).toHaveLength(3);
    expect(doc.status).toBe('succeeded');
    expect(doc.output?.providerResponseId).toBe('op-1');
    expect(doc.finishedAt?.toISOString()).toBe(at(3 * POLL_EVERY).toISOString());
    expect(rig.terminals.map((t) => t.status)).toEqual(['succeeded']);
    expect(runs).toHaveLength(1);
    // One token on the submit lane, one per poll on the poll lane.
    expect(await tokens(LANE)).toBe(1);
    expect(await tokens(POLL)).toBe(3);
  });

  it('keeps counting against the lane concurrency while the operation is in flight', async () => {
    const rig = createRig({ lanes: { [LANE]: openLane({ pollLane: POLL, maxConcurrent: 1 }), [POLL]: openLane() } });
    const runs: string[] = [];
    let finish = false;
    rig.module.runner.registerHandler(
      handlerFor(
        'video',
        async (job) => {
          runs.push(job.id);
          return submitted(rig);
        },
        async () => (finish ? { kind: 'succeeded' } : pending(rig)),
      ),
    );
    const first = await enqueueVideo(rig);
    const second = await enqueueVideo(rig);

    await tickAndSettle(rig);
    rig.clock.advance(POLL_EVERY);
    await tickAndSettle(rig);
    expect(runs).toEqual([first.id]);
    expect((await reloadJob(second.id)).status).toBe('queued');

    finish = true;
    rig.clock.advance(POLL_EVERY);
    await tickAndSettle(rig);
    expect((await reloadJob(first.id)).status).toBe('succeeded');

    await tickAndSettle(rig);
    expect(runs).toEqual([first.id, second.id]);
  });
});

describe('timeout', () => {
  it('fails an operation that is still pending after videoMaxWaitMinutes, without polling', async () => {
    const { rig, polls } = videoRig(({ rig: r }) => pending(r));
    const job = await enqueueVideo(rig);
    await tickAndSettle(rig);

    rig.clock.set(at(15 * 60_000 - 1));
    await JobModel.updateOne({ _id: job.id }, { $set: { 'operation.nextPollAt': rig.clock.now() } });
    await tickAndSettle(rig);
    expect(polls).toHaveLength(1);
    expect((await reloadJob(job.id)).status).toBe('awaiting_operation');

    rig.clock.set(at(15 * 60_000));
    await JobModel.updateOne({ _id: job.id }, { $set: { 'operation.nextPollAt': rig.clock.now() } });
    await tickAndSettle(rig);

    expect(polls).toHaveLength(1);
    const doc = await reloadJob(job.id);
    expect(doc.status).toBe('failed');
    expect(doc.error).toMatchObject({ code: 'timeout', retryable: false });
    expect(rig.terminals.map((t) => t.error?.code)).toEqual(['timeout']);
  });

  it('reads queue.videoMaxWaitMinutes live', async () => {
    const { rig, polls } = videoRig(() => ({ kind: 'succeeded' }));
    const job = await enqueueVideo(rig);
    await tickAndSettle(rig);

    rig.cfg.queue = { ...rig.cfg.queue, videoMaxWaitMinutes: 1 };
    rig.clock.set(at(61_000));
    await tickAndSettle(rig);

    expect(polls).toHaveLength(0);
    expect((await reloadJob(job.id)).error?.code).toBe('timeout');
  });
});

describe('poll lane governance', () => {
  it('defers a due poll when the poll lane has no token, without calling the handler', async () => {
    const rig = createRig({ lanes: { [LANE]: openLane({ pollLane: POLL }), [POLL]: openLane({ rpm: 1 }) } });
    const polled: string[] = [];
    rig.module.runner.registerHandler(
      handlerFor(
        'video',
        async () => submitted(rig),
        async (job) => {
          polled.push(job.id);
          return { kind: 'succeeded' };
        },
      ),
    );
    const a = await enqueueVideo(rig);
    const b = await enqueueVideo(rig);
    await tickAndSettle(rig);

    rig.clock.advance(POLL_EVERY);
    await tickAndSettle(rig);
    expect(polled).toHaveLength(1);

    const waiting = polled[0] === a.id ? b : a;
    const pushedBack = await reloadJob(waiting.id);
    expect(pushedBack.status).toBe('awaiting_operation');
    expect(pushedBack.lease).toBeUndefined();
    expect(pushedBack.operation?.nextPollAt?.toISOString()).toBe('2026-10-07T12:01:00.000Z');

    rig.clock.set('2026-10-07T12:01:00.000Z');
    await tickAndSettle(rig);
    expect(polled).toContain(waiting.id);
  });

  it('a rate limited poll pauses the poll lane and postpones the next poll, never resubmitting', async () => {
    const { rig, runs, polls } = videoRig(() => ({
      kind: 'defer',
      error: { code: 'rate_limited', message: '429', retryable: true },
      laneFailure: { kind: 'rate_limited', retryDelayMs: null, rawBody: '{"error":{"code":429}}' },
    }));
    const job = await enqueueVideo(rig);
    await tickAndSettle(rig);
    rig.clock.advance(POLL_EVERY);
    await tickAndSettle(rig);

    const doc = await reloadJob(job.id);
    expect(doc).toMatchObject({ status: 'awaiting_operation', attempts: 1, deferrals: 1 });
    expect(doc.operation?.nextPollAt?.toISOString()).toBe(at(POLL_EVERY + 10_000).toISOString());
    expect((await rig.governor.listPaused()).map((p) => [p.lane, p.reason])).toEqual([[POLL, 'rate_limited']]);
    expect(await rig.governor.pausedUntil(LANE)).toBeNull();

    // Another operation that falls due while the poll lane is paused is pushed back to the reopen time.
    const other = await insertJob({
      lane: LANE,
      type: 'video',
      status: 'awaiting_operation',
      operation: { name: 'operations/other', submittedAt: at(0), nextPollAt: at(POLL_EVERY + 1000), polls: 0 },
    });
    rig.clock.advance(1000);
    await tickAndSettle(rig);
    expect(polls).toHaveLength(1);
    const pushed = await reloadJob(other._id);
    expect(pushed.operation?.nextPollAt?.toISOString()).toBe(at(POLL_EVERY + 10_000).toISOString());
    expect(pushed.lease).toBeUndefined();
    expect(runs).toHaveLength(1);
  });

  it('a poll that throws is retried after the poll interval and never resubmits', async () => {
    const { rig, runs, polls } = videoRig(({ poll }) => {
      if (poll === 1) throw new Error('fetchPredictOperation: ECONNRESET');
      return { kind: 'succeeded' };
    });
    const job = await enqueueVideo(rig);
    await tickAndSettle(rig);
    rig.clock.advance(POLL_EVERY);
    await tickAndSettle(rig);

    let doc = await reloadJob(job.id);
    expect(doc.status).toBe('awaiting_operation');
    expect(doc.operation?.polls).toBe(1);
    expect(doc.operation?.nextPollAt?.toISOString()).toBe(at(2 * POLL_EVERY).toISOString());

    rig.clock.advance(POLL_EVERY);
    await tickAndSettle(rig);
    doc = await reloadJob(job.id);
    expect(doc.status).toBe('succeeded');
    expect(polls).toHaveLength(2);
    expect(runs).toHaveLength(1);
  });

  it('a hung poll is aborted by the 30 s poll timeout (shortened here)', async () => {
    const rig = createRig({ lanes, callTimeoutsMs: { poll: 40 } });
    let signalSeen: AbortSignal | undefined;
    rig.module.runner.registerHandler(
      handlerFor(
        'video',
        async () => submitted(rig),
        (_job, signal) => {
          signalSeen = signal;
          return new Promise(() => undefined);
        },
      ),
    );
    const job = await enqueueVideo(rig);
    await tickAndSettle(rig);
    rig.clock.advance(POLL_EVERY);
    await tickAndSettle(rig);

    expect(signalSeen?.aborted).toBe(true);
    const doc = await reloadJob(job.id);
    expect(doc.status).toBe('awaiting_operation');
    expect(doc.lease).toBeUndefined();
  });
});

describe('poll outcomes', () => {
  const failure: JobError = { code: 'safety_blocked', message: 'filtered', retryable: false };

  it('failed finishes the job', async () => {
    const { rig } = videoRig(() => ({ kind: 'failed', error: failure }));
    const job = await enqueueVideo(rig);
    await tickAndSettle(rig);
    rig.clock.advance(POLL_EVERY);
    await tickAndSettle(rig);
    expect(await reloadJob(job.id)).toMatchObject({ status: 'failed', error: { code: 'safety_blocked' } });
    expect(rig.terminals.map((t) => t.status)).toEqual(['failed']);
  });

  it('retry abandons the operation and requeues the job for a fresh submit with backoff, until attempts run out', async () => {
    const { rig, runs, polls } = videoRig(() => ({ kind: 'retry', error: { code: 'transient', message: 'operation failed', retryable: true } }));
    const job = await enqueueVideo(rig);

    const backoffs: number[] = [];
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      await tickAndSettle(rig);
      expect(runs).toHaveLength(attempt);
      rig.clock.advance(POLL_EVERY);
      await tickAndSettle(rig);
      expect(polls).toHaveLength(attempt);

      const doc = await reloadJob(job.id);
      if (attempt < 3) {
        expect(doc).toMatchObject({ status: 'queued', attempts: attempt });
        expect(doc.operation).toBeUndefined();
        backoffs.push(doc.runAt.getTime() - rig.clock.now().getTime());
        rig.clock.set(doc.runAt);
      }
    }

    expect(backoffs).toEqual([5000, 10_000]);
    expect(await reloadJob(job.id)).toMatchObject({ status: 'failed', attempts: 3 });
    expect(rig.terminals.map((t) => t.status)).toEqual(['failed']);
  });

  it('cancelling the batch ignores the operation result, whether or not a poll is in flight', async () => {
    const gate = deferred<void>();
    const rig = createRig({ lanes });
    let polls = 0;
    rig.module.runner.registerHandler(
      handlerFor(
        'video',
        async () => submitted(rig),
        async () => {
          polls += 1;
          await gate.promise;
          return { kind: 'succeeded' };
        },
      ),
    );
    const shopId = objectId();
    const batchId = objectId();
    const inFlight = await rig.module.store.enqueue({ shopId, batchId, batchItemId: objectId(), type: 'video', lane: LANE });
    await tickAndSettle(rig);

    rig.clock.advance(POLL_EVERY);
    await rig.module.runner.tickOnce();
    await waitFor(() => polls === 1);
    expect(await rig.module.store.cancelByBatch(shopId, batchId)).toBe(1);

    gate.resolve();
    await rig.module.runner.idle();
    expect(await reloadJob(inFlight.id)).toMatchObject({ status: 'cancelled' });
    expect(rig.terminals).toEqual([]);

    // A cancelled operation is never polled again.
    rig.clock.advance(POLL_EVERY);
    await tickAndSettle(rig);
    expect(polls).toBe(1);
  });
});

describe('poll claims', () => {
  it('two runners polling the same due operation poll it once', async () => {
    const clock = createClock();
    const cfg = createConfigHolder(lanes);
    const polled: string[] = [];
    const build = (instanceId: string): Rig => {
      const rig = createRig({ clock, cfg, instanceId, governor: createStubGovernor() });
      rig.module.runner.registerHandler(
        handlerFor(
          'video',
          async () => submitted(rig),
          async () => {
            polled.push(instanceId);
            await new Promise((resolve) => setTimeout(resolve, 20));
            return { kind: 'succeeded' };
          },
        ),
      );
      return rig;
    };
    const a = build('runner-a');
    const b = build('runner-b');
    await insertJob({
      lane: LANE,
      type: 'video',
      status: 'awaiting_operation',
      operation: { name: 'operations/x', submittedAt: at(0), nextPollAt: at(0), polls: 0 },
    });

    await Promise.all([a.module.runner.tickOnce(), b.module.runner.tickOnce()]);
    await Promise.all([a.module.runner.idle(), b.module.runner.idle()]);

    expect(polled).toHaveLength(1);
    expect(await JobModel.countDocuments({ status: 'succeeded' })).toBe(1);
  });

  it('skips operations whose poller still holds a live lease, and takes over once it expires', async () => {
    const { rig, polls } = videoRig(() => ({ kind: 'succeeded' }));
    const job = await insertJob({
      lane: LANE,
      type: 'video',
      status: 'awaiting_operation',
      lease: { owner: 'other-worker', expiresAt: at(60_000) },
      operation: { name: 'operations/x', submittedAt: at(0), nextPollAt: at(0), polls: 0 },
    });

    await tickAndSettle(rig);
    expect(polls).toHaveLength(0);

    rig.clock.set(at(60_001));
    await tickAndSettle(rig);
    expect(polls).toHaveLength(1);
    expect((await reloadJob(job._id)).status).toBe('succeeded');
  });

  it('does not poll job types whose handler has no poll method', async () => {
    const rig = createRig({ lanes });
    rig.module.runner.registerHandler(handlerFor('video', async () => submitted(rig)));
    const job = await insertJob({
      lane: LANE,
      type: 'video',
      status: 'awaiting_operation',
      operation: { name: 'operations/x', submittedAt: at(0), nextPollAt: at(0), polls: 0 },
    });
    await tickAndSettle(rig);
    expect((await reloadJob(job._id)).lease).toBeUndefined();
  });

  it('polls without a token when the lane has no pollLane', async () => {
    const rig = createRig({ lanes: { [LANE]: openLane({ pollLane: null }) } });
    let polled = 0;
    rig.module.runner.registerHandler(
      handlerFor(
        'video',
        async () => submitted(rig),
        async () => {
          polled += 1;
          return { kind: 'succeeded' };
        },
      ),
    );
    await enqueueVideo(rig);
    await tickAndSettle(rig);
    rig.clock.advance(POLL_EVERY);
    await tickAndSettle(rig);
    expect(polled).toBe(1);
  });
});
