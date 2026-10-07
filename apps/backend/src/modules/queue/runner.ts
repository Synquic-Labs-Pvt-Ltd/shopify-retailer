import { hostname } from 'node:os';
import { randomBytes } from 'node:crypto';
import { resolveLaneConfig, type JobType } from '@rs/shared';
import type { Logger } from '../../core/logger';
import type { LaneDecision, LaneFailure } from '../ratelimit';
import { claimDuePoll, claimNext, extendRunLease } from './claims';
import { releaseDependents, releaseOrphanedBlocked } from './dependencies';
import type { CallTimeoutsMs, JobHandler, QueueModuleOptions, QueueRunnerControl } from './index';
import { toQueueJob } from './mapper';
import { JobModel, type JobDoc } from './models';
import { reapExpiredLeases } from './reaper';
import {
  deferPoll,
  failPollTimeout,
  settlePoll,
  settleRun,
  type PollResult,
  type RunResult,
  type SettleContext,
  type Settled,
} from './settle';

export const DEFAULT_CALL_TIMEOUTS_MS: CallTimeoutsMs = { plan: 90_000, image: 150_000, videoSubmit: 60_000, poll: 30_000 };

const DEFAULT_REAP_INTERVAL_MS = 30_000;
const DEFAULT_SHUTDOWN_GRACE_MS = 10_000;
// Bounds one tick when a lane has no limits at all.
const MAX_CLAIMS_PER_LANE_PER_TICK = 50;
const MAX_POLLS_PER_TICK = 100;
const MINUTE_MS = 60_000;

class LeaseLostError extends Error {
  constructor() {
    super('lease lost');
    this.name = 'LeaseLostError';
  }
}

// Rejects as soon as the signal aborts, even if the handler ignores it. The handler promise keeps a
// handler attached so a late rejection is never reported as unhandled.
function raceAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => reject(signal.reason);
    if (signal.aborted) {
      onAbort();
    } else {
      signal.addEventListener('abort', onAbort, { once: true });
    }
    promise.then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener('abort', onAbort);
        reject(error);
      },
    );
  });
}

function describeError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function createRunner(options: QueueModuleOptions): QueueRunnerControl {
  const { getConfig, governor } = options;
  const logger: Logger = options.logger.child({ module: 'queue' });
  const clock = options.now ?? (() => new Date());
  const random = options.random ?? Math.random;
  const instanceId = options.instanceId ?? `${hostname()}:${process.pid}:${randomBytes(3).toString('hex')}`;
  const timeouts: CallTimeoutsMs = { ...DEFAULT_CALL_TIMEOUTS_MS, ...options.callTimeoutsMs };
  const reapIntervalMs = options.reapIntervalMs ?? DEFAULT_REAP_INTERVAL_MS;
  const shutdownGraceMs = options.shutdownGraceMs ?? DEFAULT_SHUTDOWN_GRACE_MS;

  const handlers = new Map<JobType, JobHandler>();
  const inFlight = new Set<Promise<void>>();
  let shutdown = new AbortController();
  let running = false;
  // Set by stop(): ticks already underway stop claiming new work.
  let stopping = false;
  let timer: NodeJS.Timeout | undefined;
  let currentTick: Promise<void> | null = null;
  let lastTickAt: Date | null = null;
  let nextReapAt = 0;

  const settleContext = (): SettleContext => ({ now: clock(), config: getConfig().queue, random, owner: instanceId });

  const timeoutFor = (type: JobType): number =>
    type === 'plan' ? timeouts.plan : type === 'image' ? timeouts.image : timeouts.videoSubmit;

  const pollLaneOf = (job: JobDoc): string | null => resolveLaneConfig(getConfig().lanes, job.lane)?.pollLane ?? null;

  // Feeds the governor and returns the pause decision a defer outcome needs.
  const reportLane = async (lane: string, result: RunResult | PollResult): Promise<LaneDecision | null> => {
    try {
      if (result.kind === 'succeeded' || result.kind === 'awaiting_operation') {
        await governor.recordSuccess(lane);
      } else if ('laneFailure' in result && result.laneFailure !== undefined) {
        const failure: LaneFailure = result.laneFailure;
        return await governor.recordFailure(lane, failure);
      }
    } catch (err) {
      logger.error({ err, lane }, 'cannot record lane outcome');
    }
    return null;
  };

  // After a job turned terminal: release its dependents, then tell the owner (batches aggregation).
  const afterSettled = async (result: Settled): Promise<void> => {
    if (!result.terminal) return;
    try {
      await releaseDependents(result.doc, clock());
    } catch (err) {
      logger.error({ err, jobId: result.doc._id.toHexString() }, 'cannot release dependents (the reaper will retry)');
    }
    if (options.onTerminal === undefined) return;
    try {
      await options.onTerminal(toQueueJob(result.doc));
    } catch (err) {
      logger.error({ err, jobId: result.doc._id.toHexString() }, 'onTerminal failed');
    }
  };

  const settleAndFinish = async (job: JobDoc, mode: 'run' | 'poll', lane: string, result: RunResult | PollResult): Promise<void> => {
    const decision = await reportLane(lane, result);
    const ctx = settleContext();
    const done =
      mode === 'run' ? await settleRun(job, result as RunResult, decision, ctx) : await settlePoll(job, result as PollResult, decision, ctx);
    if (done === null) {
      logger.warn({ jobId: job._id.toHexString(), kind: result.kind }, 'outcome dropped: the job is no longer owned by this runner');
      return;
    }
    await afterSettled(done);
  };

  const heartbeat = async (job: JobDoc, control: AbortController): Promise<void> => {
    try {
      const owned = await extendRunLease(job, instanceId, clock(), getConfig().queue.leaseMs);
      if (!owned) control.abort(new LeaseLostError());
    } catch (err) {
      logger.warn({ err, jobId: job._id.toHexString() }, 'lease heartbeat failed');
    }
  };

  const executeRun = async (job: JobDoc, handler: JobHandler): Promise<void> => {
    const control = new AbortController();
    const timeoutMs = timeoutFor(job.type);
    const timeoutSignal = AbortSignal.timeout(timeoutMs);
    const signal = AbortSignal.any([control.signal, timeoutSignal, shutdown.signal]);
    const beat = setInterval(() => void heartbeat(job, control), Math.max(1, Math.floor(getConfig().queue.leaseMs / 3)));

    let result: RunResult;
    try {
      result = await raceAbort(handler.run(toQueueJob(job), signal), signal);
    } catch (err) {
      if (control.signal.aborted) {
        logger.warn({ jobId: job._id.toHexString() }, 'lease lost while the handler ran; dropping its outcome');
        return;
      }
      if (shutdown.signal.aborted) {
        result = { kind: 'interrupted' };
      } else if (timeoutSignal.aborted) {
        result = { kind: 'retry', error: { code: 'timeout', message: `Handler exceeded ${timeoutMs} ms`, retryable: true } };
      } else {
        logger.error({ err, jobId: job._id.toHexString(), type: job.type }, 'handler threw');
        result = { kind: 'retry', error: { code: 'transient', message: describeError(err), retryable: true } };
      }
    } finally {
      clearInterval(beat);
    }

    // The handler finished just as the lease was lost: the fenced settle below would drop it anyway.
    await settleAndFinish(job, 'run', job.lane, result);
  };

  const executePoll = async (job: JobDoc, handler: JobHandler, pollLane: string | null): Promise<void> => {
    const poll = handler.poll;
    if (poll === undefined) return;
    const signal = AbortSignal.any([AbortSignal.timeout(timeouts.poll), shutdown.signal]);

    let result: PollResult;
    try {
      result = await raceAbort(poll.call(handler, toQueueJob(job), signal), signal);
    } catch (err) {
      // Polling is cheap and the operation is already paid for: never resubmit because a poll failed.
      const delay = shutdown.signal.aborted ? 0 : getConfig().queue.videoPollIntervalMs;
      if (!shutdown.signal.aborted) logger.warn({ err, jobId: job._id.toHexString() }, 'poll failed, will poll again');
      result = { kind: 'repoll', nextPollAt: new Date(clock().getTime() + delay) };
    }
    await settleAndFinish(job, 'poll', pollLane ?? job.lane, result);
  };

  const track = (work: Promise<void>): void => {
    const tracked: Promise<void> = work
      .catch((err: unknown) => logger.error({ err }, 'job execution failed'))
      .finally(() => inFlight.delete(tracked));
    inFlight.add(tracked);
  };

  const fillLane = async (lane: string, types: JobType[]): Promise<void> => {
    for (let claimed = 0; claimed < MAX_CLAIMS_PER_LANE_PER_TICK && !stopping; claimed += 1) {
      const grant = await governor.acquire(lane);
      if (!grant.granted) return;
      const job = await claimNext(lane, types, instanceId, clock(), getConfig().queue.leaseMs);
      if (job === null) {
        await governor.release(lane, grant.tokens);
        return;
      }
      const handler = handlers.get(job.type);
      if (handler === undefined) continue;
      track(executeRun(job, handler));
    }
  };

  const fillLanes = async (): Promise<void> => {
    const types = [...handlers.keys()];
    if (types.length === 0) return;
    const lanes = await JobModel.distinct('lane', { status: 'queued', runAt: { $lte: clock() }, type: { $in: types } });
    const outcomes = await Promise.allSettled(lanes.sort().map((lane) => fillLane(lane, types)));
    const failed = outcomes.find((outcome): outcome is PromiseRejectedResult => outcome.status === 'rejected');
    if (failed !== undefined) throw failed.reason;
  };

  const pollOperations = async (): Promise<void> => {
    const pollTypes = [...handlers.values()].filter((handler) => handler.poll !== undefined).map((handler) => handler.type);
    if (pollTypes.length === 0) return;
    const reopenAt = new Map<string, Date>();

    for (let polled = 0; polled < MAX_POLLS_PER_TICK && !stopping; polled += 1) {
      const now = clock();
      const config = getConfig();
      const job = await claimDuePoll(pollTypes, instanceId, now, config.queue.leaseMs);
      if (job === null) return;

      const submittedAt = job.operation?.submittedAt;
      const maxWaitMinutes = config.queue.videoMaxWaitMinutes;
      if (submittedAt !== undefined && now.getTime() - submittedAt.getTime() >= maxWaitMinutes * MINUTE_MS) {
        const timedOut = await failPollTimeout(job, maxWaitMinutes, settleContext());
        if (timedOut !== null) await afterSettled(timedOut);
        continue;
      }

      const pollLane = pollLaneOf(job);
      if (pollLane !== null) {
        const blockedUntil = reopenAt.get(pollLane);
        if (blockedUntil !== undefined) {
          await deferPoll(job, blockedUntil, instanceId);
          continue;
        }
        const grant = await governor.acquire(pollLane);
        if (!grant.granted) {
          reopenAt.set(pollLane, grant.reopensAt);
          await deferPoll(job, grant.reopensAt, instanceId);
          continue;
        }
      }

      const handler = handlers.get(job.type);
      if (handler === undefined) continue;
      track(executePoll(job, handler, pollLane));
    }
  };

  const reapIfDue = async (): Promise<void> => {
    const now = clock();
    if (now.getTime() < nextReapAt) return;
    nextReapAt = now.getTime() + reapIntervalMs;
    const reaped = await reapExpiredLeases(now, getConfig().queue, random);
    for (const result of reaped) {
      logger.warn(
        { jobId: result.doc._id.toHexString(), status: result.doc.status, attempts: result.doc.attempts },
        'reaped a job with an expired lease',
      );
      await afterSettled(result);
    }
    const released = await releaseOrphanedBlocked(now);
    if (released > 0) logger.warn({ released }, 'released blocked jobs whose dependencies were already terminal');
  };

  const tick = async (): Promise<void> => {
    let healthy = true;
    const step = async (name: string, fn: () => Promise<void>): Promise<void> => {
      try {
        await fn();
      } catch (err) {
        healthy = false;
        logger.error({ err, step: name }, 'queue tick step failed');
      }
    };
    await step('lanes', fillLanes);
    await step('polls', pollOperations);
    await step('reaper', reapIfDue);
    if (healthy) lastTickAt = clock();
  };

  // Concurrent callers share one tick, so a tick never overlaps with itself.
  const tickOnce = (): Promise<void> => {
    if (currentTick === null) {
      currentTick = tick().finally(() => {
        currentTick = null;
      });
    }
    return currentTick;
  };

  const idle = async (): Promise<void> => {
    while (inFlight.size > 0) await Promise.allSettled([...inFlight]);
  };

  const loop = async (): Promise<void> => {
    if (!running) return;
    await tickOnce();
    if (running) timer = setTimeout(() => void loop(), getConfig().queue.tickMs);
  };

  return {
    registerHandler(handler) {
      if (handlers.has(handler.type)) throw new Error(`A handler for job type "${handler.type}" is already registered`);
      handlers.set(handler.type, handler);
    },

    start() {
      if (running) return;
      running = true;
      stopping = false;
      shutdown = new AbortController();
      logger.info({ instanceId }, 'queue runner started');
      void loop();
    },

    async stop() {
      if (!running && inFlight.size === 0) return;
      running = false;
      stopping = true;
      if (timer !== undefined) clearTimeout(timer);
      timer = undefined;
      await currentTick;
      const grace = new Promise<'timeout'>((resolve) => {
        const t = setTimeout(() => resolve('timeout'), shutdownGraceMs);
        t.unref();
      });
      if ((await Promise.race([idle().then(() => 'idle' as const), grace])) === 'timeout') {
        logger.warn({ inFlight: inFlight.size }, 'aborting in-flight jobs on shutdown');
        shutdown.abort();
        await idle();
      }
      logger.info('queue runner stopped');
    },

    get lastTickAt() {
      return lastTickAt;
    },

    tickOnce,
    idle,
  };
}
