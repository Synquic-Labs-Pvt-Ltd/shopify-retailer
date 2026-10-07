import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { AiErrorKind, JobErrorCode } from '@rs/shared';
import type { JobError, JobOutcome, QueueJob } from '../../src/modules/queue';
import { JobModel } from '../../src/modules/queue/models';
import { LaneStateModel } from '../../src/modules/ratelimit/models';
import { MONGO_START_TIMEOUT_MS, startTestMongo, type TestMongo } from '../helpers/mongo';
import {
  createRig,
  deferred,
  ERROR_LEVEL,
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
  mongo = await startTestMongo('rs_queue_outcomes');
}, MONGO_START_TIMEOUT_MS);

afterAll(async () => {
  await mongo.stop();
});

beforeEach(async () => {
  await mongo.clear();
});

const LANE = 'test:img';
const at = (offsetMs: number): Date => new Date(new Date(START).getTime() + offsetMs);

const error = (code: JobErrorCode, extra: Partial<JobError> = {}): JobError => ({
  code,
  message: `${code} happened`,
  retryable: false,
  ...extra,
});

function rigWith(outcomes: (job: QueueJob, call: number) => JobOutcome | Promise<JobOutcome>, options: Parameters<typeof createRig>[0] = {}) {
  const rig = createRig({ lanes: { [LANE]: openLane() }, ...options });
  const calls: QueueJob[] = [];
  rig.module.runner.registerHandler(
    handlerFor('image', async (job) => {
      calls.push(job);
      return outcomes(job, calls.length);
    }),
  );
  return { rig, calls };
}

const enqueue = (rig: Rig) =>
  rig.module.store.enqueue({ shopId: objectId(), batchId: objectId(), batchItemId: objectId(), type: 'image', lane: LANE });

describe('succeeded', () => {
  it('stores output and audit, clears the lease, notifies onTerminal and records the lane success', async () => {
    const mediaAssetId = objectId();
    const { rig } = rigWith(() => ({
      kind: 'succeeded',
      output: { mediaAssetId, providerResponseId: 'resp-1', modelVersion: 'model-v1' },
      audit: { promptVersion: 'abc123', renderedPrompt: 'a rendered prompt' },
    }));
    const job = await enqueue(rig);

    await tickAndSettle(rig);

    const doc = await reloadJob(job.id);
    expect(doc).toMatchObject({ status: 'succeeded', attempts: 1, promptVersion: 'abc123', renderedPrompt: 'a rendered prompt' });
    expect(doc.output?.mediaAssetId?.toHexString()).toBe(mediaAssetId);
    expect(doc.output?.providerResponseId).toBe('resp-1');
    expect(doc.finishedAt?.toISOString()).toBe(START);
    expect(doc.lease).toBeUndefined();
    expect(rig.terminals.map((t) => [t.id, t.status])).toEqual([[job.id, 'succeeded']]);
    expect(rig.terminals[0]?.output?.mediaAssetId).toBe(mediaAssetId);
    expect((await LaneStateModel.findById(LANE).lean())?.lastSuccessAt?.toISOString()).toBe(START);
  });
});

describe('failed and cancelled', () => {
  it('failed is final: the error is stored and the job is never retried', async () => {
    const { rig, calls } = rigWith(() => ({
      kind: 'failed',
      error: error('invalid_request', { httpStatus: 400, providerReason: 'INVALID_ARGUMENT' }),
      laneFailure: { kind: 'invalid_request', retryDelayMs: null, rawBody: '{"error":{}}' },
    }));
    const job = await enqueue(rig);

    await tickAndSettle(rig);
    rig.clock.advance(3_600_000);
    await tickAndSettle(rig);

    const doc = await reloadJob(job.id);
    expect(doc.status).toBe('failed');
    expect(doc.error).toMatchObject({ code: 'invalid_request', httpStatus: 400, providerReason: 'INVALID_ARGUMENT', retryable: false });
    expect(doc.error?.at?.toISOString()).toBe(START);
    expect(calls).toHaveLength(1);
    expect(await rig.governor.listPaused()).toEqual([]);
    expect(rig.terminals.map((t) => t.status)).toEqual(['failed']);
  });

  it('safety_blocked fails without a retry or a lane pause', async () => {
    const { rig, calls } = rigWith(() => ({
      kind: 'failed',
      error: error('safety_blocked'),
      laneFailure: { kind: 'safety_blocked', retryDelayMs: null, rawBody: null },
    }));
    const job = await enqueue(rig);
    await tickAndSettle(rig);
    expect((await reloadJob(job.id)).status).toBe('failed');
    expect(calls).toHaveLength(1);
    expect(await rig.governor.pausedUntil(LANE)).toBeNull();
  });

  it('cancelled outcome ends the job as cancelled', async () => {
    const { rig } = rigWith(() => ({ kind: 'cancelled' }));
    const job = await enqueue(rig);
    await tickAndSettle(rig);
    expect((await reloadJob(job.id)).status).toBe('cancelled');
    expect(rig.terminals.map((t) => t.status)).toEqual(['cancelled']);
  });
});

describe('retry', () => {
  it('requeues with backoffBaseMs x 2^(attempts-1) plus jitter, and fails when attempts reach maxAttempts', async () => {
    let jitter = 0;
    const { rig, calls } = rigWith(() => ({ kind: 'retry', error: error('transient', { retryable: true }) }), { random: () => jitter });
    const job = await enqueue(rig);

    await tickAndSettle(rig);
    let doc = await reloadJob(job.id);
    expect(doc).toMatchObject({ status: 'queued', attempts: 1 });
    expect(doc.runAt.toISOString()).toBe(at(5000).toISOString());
    expect(doc.error?.code).toBe('transient');

    rig.clock.advance(4_999);
    await tickAndSettle(rig);
    expect(calls).toHaveLength(1);

    jitter = 1;
    rig.clock.advance(1);
    await tickAndSettle(rig);
    doc = await reloadJob(job.id);
    expect(calls).toHaveLength(2);
    expect(doc).toMatchObject({ status: 'queued', attempts: 2 });
    expect(doc.runAt.toISOString()).toBe(at(5000 + 10_000 + 1000).toISOString());

    rig.clock.set(doc.runAt);
    await tickAndSettle(rig);
    doc = await reloadJob(job.id);
    expect(calls).toHaveLength(3);
    expect(doc).toMatchObject({ status: 'failed', attempts: 3 });
    expect(doc.error).toMatchObject({ code: 'transient', retryable: false });
    expect(rig.terminals.map((t) => t.status)).toEqual(['failed']);
  });

  it('caps the backoff at backoffMaxMs', async () => {
    const { rig } = rigWith(() => ({ kind: 'retry', error: error('transient', { retryable: true }) }), { random: () => 1 });
    rig.cfg.queue = { ...rig.cfg.queue, maxAttempts: 6, backoffMaxMs: 12_000 };
    const job = await enqueue(rig);

    const delays: number[] = [];
    for (let i = 0; i < 4; i += 1) {
      await tickAndSettle(rig);
      const doc = await reloadJob(job.id);
      delays.push(doc.runAt.getTime() - rig.clock.now().getTime());
      rig.clock.set(doc.runAt);
    }
    expect(delays).toEqual([6000, 11_000, 12_000, 12_000]);
  });

  it('a transient failure does not pause the lane', async () => {
    const { rig } = rigWith(() => ({
      kind: 'retry',
      error: error('transient', { retryable: true, httpStatus: 503 }),
      laneFailure: { kind: 'transient', retryDelayMs: null, rawBody: '{"error":{"status":"UNAVAILABLE"}}' },
    }));
    await enqueue(rig);
    await tickAndSettle(rig);
    expect(await rig.governor.listPaused()).toEqual([]);
  });

  it('no_output gets one retry and then fails, whatever maxAttempts is', async () => {
    const { rig, calls } = rigWith(() => ({
      kind: 'retry',
      error: error('no_output', { retryable: true }),
      laneFailure: { kind: 'no_output', retryDelayMs: null, rawBody: null },
    }));
    const job = await enqueue(rig);

    await tickAndSettle(rig);
    expect((await reloadJob(job.id)).status).toBe('queued');
    rig.clock.advance(5000);
    await tickAndSettle(rig);

    const doc = await reloadJob(job.id);
    expect(calls).toHaveLength(2);
    expect(doc).toMatchObject({ status: 'failed', attempts: 2 });
    expect(doc.error?.code).toBe('no_output');
  });

  it('a handler that throws becomes a transient retry that consumes an attempt', async () => {
    const { rig } = rigWith(() => {
      throw new Error('socket hang up');
    });
    const job = await enqueue(rig);

    await tickAndSettle(rig);

    const doc = await reloadJob(job.id);
    expect(doc).toMatchObject({ status: 'queued', attempts: 1 });
    expect(doc.error).toMatchObject({ code: 'transient', message: 'socket hang up', retryable: true });
    expect(rig.logs.some((line) => line.level === ERROR_LEVEL && line.msg === 'handler threw')).toBe(true);
  });

  it('aborts a call that exceeds its timeout, even if the handler ignores the signal', async () => {
    const rig = createRig({ lanes: { [LANE]: openLane() }, callTimeoutsMs: { image: 40 } });
    let receivedSignal: AbortSignal | undefined;
    rig.module.runner.registerHandler(
      handlerFor('image', (_job, signal) => {
        receivedSignal = signal;
        return new Promise(() => undefined);
      }),
    );
    const job = await enqueue(rig);

    await tickAndSettle(rig);

    expect(receivedSignal?.aborted).toBe(true);
    const doc = await reloadJob(job.id);
    expect(doc).toMatchObject({ status: 'queued', attempts: 1 });
    expect(doc.error).toMatchObject({ code: 'timeout', retryable: true });
  });
});

describe('defer (SPEC 11.2 lane pause table)', () => {
  const rows: Array<{ kind: AiErrorKind; code: JobErrorCode; resumesAt: string; zone?: string; retryDelayMs?: number }> = [
    { kind: 'rate_limited', code: 'rate_limited', resumesAt: '2026-10-07T12:00:10.000Z' },
    { kind: 'rate_limited', code: 'rate_limited', resumesAt: '2026-10-07T12:00:45.000Z', retryDelayMs: 45_000 },
    { kind: 'daily_quota', code: 'daily_quota', resumesAt: '2026-10-08T07:00:00.000Z', zone: 'America/Los_Angeles' },
    { kind: 'daily_quota', code: 'daily_quota', resumesAt: '2026-10-08T00:00:00.000Z', zone: 'UTC' },
    { kind: 'provider_unavailable', code: 'provider_unavailable', resumesAt: '2026-10-07T12:15:00.000Z' },
    { kind: 'auth_error', code: 'auth_error', resumesAt: '2026-10-07T12:15:00.000Z' },
  ];

  it.each(rows)('$kind (retryDelay $retryDelayMs, zone $zone) pauses the lane and requeues without spending an attempt', async (row) => {
    const { rig, calls } = rigWith(
      () => ({
        kind: 'defer',
        error: error(row.code, { retryable: true }),
        laneFailure: { kind: row.kind, retryDelayMs: row.retryDelayMs ?? null, rawBody: '{"error":{"code":429}}' },
      }),
      { lanes: { [LANE]: openLane({ dailyResetTimeZone: row.zone ?? 'UTC' }) } },
    );
    const job = await enqueue(rig);

    await tickAndSettle(rig);

    const doc = await reloadJob(job.id);
    expect(doc).toMatchObject({ status: 'queued', attempts: 0, deferrals: 1 });
    expect(doc.runAt.toISOString()).toBe(row.resumesAt);
    expect(doc.error?.code).toBe(row.code);
    const paused = await rig.governor.listPaused();
    expect(paused.map((p) => [p.lane, p.reason, p.pausedUntil.toISOString()])).toEqual([[LANE, row.kind, row.resumesAt]]);

    // Not before the lane reopens...
    rig.clock.set(new Date(new Date(row.resumesAt).getTime() - 1000));
    await tickAndSettle(rig);
    expect(calls).toHaveLength(1);
    // ...and it runs again as attempt 1, not attempt 2, once it does.
    rig.clock.set(row.resumesAt);
    await tickAndSettle(rig);
    expect(calls).toHaveLength(2);
    expect(calls[1]?.attempts).toBe(1);
  });

  it('survives many deferrals without burning attempts, escalating the lane pause 10, 20, 40 ... seconds', async () => {
    const { rig } = rigWith(() => ({
      kind: 'defer',
      error: error('rate_limited', { retryable: true }),
      laneFailure: { kind: 'rate_limited', retryDelayMs: null, rawBody: null },
    }));
    const job = await enqueue(rig);

    const gaps: number[] = [];
    for (let i = 0; i < 5; i += 1) {
      await tickAndSettle(rig);
      const doc = await reloadJob(job.id);
      expect(doc).toMatchObject({ status: 'queued', attempts: 0, deferrals: i + 1 });
      gaps.push(doc.runAt.getTime() - rig.clock.now().getTime());
      rig.clock.set(doc.runAt);
    }
    expect(gaps).toEqual([10_000, 20_000, 40_000, 80_000, 160_000]);
    expect(rig.terminals).toEqual([]);
  });

  it('a success on the lane resets the escalation', async () => {
    let fail = true;
    const { rig } = rigWith(() =>
      fail
        ? { kind: 'defer', error: error('rate_limited', { retryable: true }), laneFailure: { kind: 'rate_limited', retryDelayMs: null, rawBody: null } }
        : { kind: 'succeeded' },
    );
    const first = await enqueue(rig);
    await tickAndSettle(rig);
    rig.clock.set((await reloadJob(first.id)).runAt);
    fail = false;
    await tickAndSettle(rig);
    expect((await reloadJob(first.id)).status).toBe('succeeded');
    expect((await LaneStateModel.findById(LANE).lean())?.consecutiveRateLimits).toBe(0);
  });

  it('other queued jobs of a paused lane wait for the pause too', async () => {
    let first = true;
    const { rig, calls } = rigWith(
      () => {
        if (!first) return { kind: 'succeeded' };
        first = false;
        return {
          kind: 'defer',
          error: error('provider_unavailable', { retryable: true }),
          laneFailure: { kind: 'provider_unavailable', retryDelayMs: null, rawBody: '{"error":{"message":"billing disabled"}}' },
        };
      },
      { lanes: { [LANE]: openLane({ maxConcurrent: 1 }) } },
    );
    await enqueue(rig);
    await enqueue(rig);

    await tickAndSettle(rig);
    expect(calls).toHaveLength(1);
    rig.clock.advance(60_000);
    await tickAndSettle(rig);
    expect(calls).toHaveLength(1);

    rig.clock.advance(15 * 60_000);
    await tickAndSettle(rig);
    await tickAndSettle(rig);
    expect(calls).toHaveLength(3);
    expect(await JobModel.countDocuments({ status: 'succeeded' })).toBe(2);
  });

  it('logs provider_unavailable at error level with the raw body', async () => {
    const rawBody = '{"error":{"status":"PERMISSION_DENIED","message":"Billing is disabled"}}';
    const { rig } = rigWith(() => ({
      kind: 'defer',
      error: error('provider_unavailable', { retryable: true }),
      laneFailure: { kind: 'provider_unavailable', retryDelayMs: null, rawBody },
    }));
    await enqueue(rig);
    await tickAndSettle(rig);
    const logged = rig.logs.find((line) => line.level === ERROR_LEVEL && line.rawBody === rawBody);
    expect(logged?.lane).toBe(LANE);
  });

  it('without a laneFailure it requeues at the given runAt', async () => {
    const { rig } = rigWith(() => ({ kind: 'defer', error: error('rate_limited', { retryable: true }), runAt: at(90_000) }));
    const job = await enqueue(rig);
    await tickAndSettle(rig);
    const doc = await reloadJob(job.id);
    expect(doc).toMatchObject({ status: 'queued', attempts: 0, deferrals: 1 });
    expect(doc.runAt.toISOString()).toBe(at(90_000).toISOString());
    expect(await rig.governor.listPaused()).toEqual([]);
  });
});

describe('jobMaxAgeHours', () => {
  const deferUntil = (runAt: Date): JobOutcome => ({ kind: 'defer', error: error('rate_limited', { retryable: true }), runAt });

  it('fails a job deferred beyond the max age with quota_timeout', async () => {
    const { rig } = rigWith(() => deferUntil(at(25 * 3_600_000)));
    const job = await enqueue(rig);

    await tickAndSettle(rig);

    const doc = await reloadJob(job.id);
    expect(doc.status).toBe('failed');
    expect(doc.error).toMatchObject({ code: 'quota_timeout', retryable: false });
    expect(doc.error?.message).toContain('rate_limited');
    expect(rig.terminals.map((t) => t.error?.code)).toEqual(['quota_timeout']);
  });

  it('keeps a job whose deferral ends inside the max age', async () => {
    const { rig } = rigWith(() => deferUntil(at(23 * 3_600_000)));
    const job = await enqueue(rig);
    await tickAndSettle(rig);
    expect((await reloadJob(job.id)).status).toBe('queued');
  });

  it('measures the age from createdAt, so an old job fails on its first long deferral', async () => {
    const { rig } = rigWith(() => ({
      kind: 'defer',
      error: error('daily_quota', { retryable: true }),
      laneFailure: { kind: 'daily_quota', retryDelayMs: null, rawBody: null },
    }));
    const old = await insertJob({ lane: LANE, createdAt: at(-20 * 3_600_000) });
    await tickAndSettle(rig);
    // The next UTC midnight is 12 h away, i.e. 32 h after creation.
    expect(await reloadJob(old._id)).toMatchObject({ status: 'failed', error: { code: 'quota_timeout' } });

    // The same deferral is fine when the live max age is longer.
    await LaneStateModel.deleteMany({});
    rig.cfg.queue = { ...rig.cfg.queue, jobMaxAgeHours: 48 };
    const other = await insertJob({ lane: LANE, createdAt: at(-20 * 3_600_000) });
    await tickAndSettle(rig);
    expect(await reloadJob(other._id)).toMatchObject({ status: 'queued', attempts: 0 });
  });

  it('a retried job is aged from the retry, not from its creation', async () => {
    const { rig } = rigWith(() => deferUntil(at(60_000)));
    const batch = { shopId: objectId(), batchId: objectId() };
    const old = await insertJob({ ...batch, lane: LANE, status: 'failed', createdAt: at(-3 * 24 * 3_600_000) });
    expect(await rig.module.store.requeueFailed(batch.shopId, batch.batchId)).toBe(1);

    await tickAndSettle(rig);
    expect((await reloadJob(old._id)).status).toBe('queued');
  });
});

describe('stale outcomes', () => {
  it('drops the outcome of a job that was cancelled while it ran', async () => {
    const gate = deferred<void>();
    const rig = createRig({ lanes: { [LANE]: openLane() } });
    rig.module.runner.registerHandler(
      handlerFor('image', async () => {
        await gate.promise;
        return { kind: 'succeeded' };
      }),
    );
    const shopId = objectId();
    const job = await rig.module.store.enqueue({ shopId, batchId: objectId(), batchItemId: objectId(), type: 'image', lane: LANE });
    await rig.module.runner.tickOnce();
    expect(await rig.module.store.cancelByShop(shopId)).toBe(1);

    gate.resolve();
    await rig.module.runner.idle();

    expect((await reloadJob(job.id)).status).toBe('cancelled');
    expect(rig.terminals).toEqual([]);
  });

  it('aborts the handler when its lease is lost', async () => {
    const rig = createRig({ lanes: { [LANE]: openLane() } });
    rig.cfg.queue = { ...rig.cfg.queue, leaseMs: 90 };
    let aborted = false;
    let started = false;
    rig.module.runner.registerHandler(
      handlerFor(
        'image',
        (_job, signal) =>
          new Promise((_resolve, reject) => {
            started = true;
            signal.addEventListener('abort', () => {
              aborted = true;
              reject(signal.reason);
            });
          }),
      ),
    );
    const shopId = objectId();
    await rig.module.store.enqueue({ shopId, batchId: objectId(), batchItemId: objectId(), type: 'image', lane: LANE });
    await rig.module.runner.tickOnce();
    await waitFor(() => started);

    await rig.module.store.cancelByShop(shopId);
    await waitFor(() => aborted);
    await rig.module.runner.idle();

    expect(rig.terminals).toEqual([]);
  });

  it('swallows an onTerminal failure and still finishes the job', async () => {
    const { rig } = rigWith(() => ({ kind: 'succeeded' }), {
      onTerminal: () => {
        throw new Error('aggregation exploded');
      },
    });
    const job = await enqueue(rig);
    await tickAndSettle(rig);
    expect((await reloadJob(job.id)).status).toBe('succeeded');
    expect(rig.logs.some((line) => line.level === ERROR_LEVEL && line.msg === 'onTerminal failed')).toBe(true);
  });
});
