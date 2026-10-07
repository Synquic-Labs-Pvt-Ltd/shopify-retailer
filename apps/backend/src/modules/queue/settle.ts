import type { QueueConfig } from '@rs/shared';
import type { LaneDecision } from '../ratelimit';
import { backoffMs } from './backoff';
import type { JobAudit, JobError, JobOutcome } from './index';
import { JobModel, type JobDoc } from './models';

export interface SettleContext {
  now: Date;
  config: QueueConfig;
  random: () => number;
  owner: string;
}

// What the runner adds to a handler's JobOutcome.
// interrupted: the process is shutting down; give the job back without spending an attempt.
// repoll: a poll could not complete (handler threw); try again at nextPollAt.
export type RunResult = JobOutcome | { kind: 'interrupted' };
export type PollResult = JobOutcome | { kind: 'repoll'; nextPollAt: Date };

export interface Settled {
  doc: JobDoc;
  terminal: boolean;
}

const HOUR_MS = 3_600_000;
const NO_OUTPUT_MAX_ATTEMPTS = 2;

type Update = Record<string, Record<string, unknown>>;

function errorDoc(error: JobError, at: Date): Record<string, unknown> {
  return {
    code: error.code,
    message: error.message,
    retryable: error.retryable,
    at,
    ...(error.providerReason === undefined ? {} : { providerReason: error.providerReason }),
    ...(error.httpStatus === undefined ? {} : { httpStatus: error.httpStatus }),
  };
}

function auditFields(audit: JobAudit | undefined): Record<string, unknown> {
  return {
    ...(audit?.promptVersion === undefined ? {} : { promptVersion: audit.promptVersion }),
    ...(audit?.renderedPrompt === undefined ? {} : { renderedPrompt: audit.renderedPrompt }),
  };
}

// SPEC 11.2: no_output gets one retry, then fails.
function maxAttemptsFor(job: JobDoc, error: JobError): number {
  return error.code === 'no_output' ? Math.min(job.maxAttempts, NO_OUTPUT_MAX_ATTEMPTS) : job.maxAttempts;
}

function failedUpdate(error: JobError, audit: JobAudit | undefined, now: Date): Update {
  return { $set: { status: 'failed', finishedAt: now, error: errorDoc(error, now), ...auditFields(audit) }, $unset: { lease: 1 } };
}

function succeededUpdate(outcome: Extract<JobOutcome, { kind: 'succeeded' }>, now: Date): Update {
  const output: Record<string, unknown> =
    outcome.output === undefined
      ? {}
      : {
          'output.mediaAssetId': outcome.output.mediaAssetId,
          'output.providerResponseId': outcome.output.providerResponseId,
          'output.modelVersion': outcome.output.modelVersion,
        };
  return {
    $set: { status: 'succeeded', finishedAt: now, ...output, ...auditFields(outcome.audit) },
    $unset: { lease: 1, error: 1 },
  };
}

function cancelledUpdate(now: Date): Update {
  return {
    $set: { status: 'cancelled', finishedAt: now, error: { code: 'cancelled', message: 'Cancelled', retryable: false, at: now } },
    $unset: { lease: 1 },
  };
}

function requeueUpdate(error: JobError, audit: JobAudit | undefined, runAt: Date, now: Date): Update {
  return { $set: { status: 'queued', runAt, error: errorDoc(error, now), ...auditFields(audit) }, $unset: { lease: 1 } };
}

async function apply(filter: Record<string, unknown>, update: Update): Promise<JobDoc | null> {
  return JobModel.findOneAndUpdate(filter, update, { returnDocument: 'after' }).lean<JobDoc>();
}

function settled(doc: JobDoc | null): Settled | null {
  if (doc === null) return null;
  return { doc, terminal: doc.status === 'succeeded' || doc.status === 'failed' || doc.status === 'cancelled' };
}

function runFence(job: JobDoc, owner: string): Record<string, unknown> {
  return { _id: job._id, status: 'running', 'lease.owner': owner, attempts: job.attempts };
}

function pollFence(job: JobDoc, owner: string): Record<string, unknown> {
  return { _id: job._id, status: 'awaiting_operation', 'lease.owner': owner };
}

// A job deferred past queue.jobMaxAgeHours since it was created (or last requeued) fails for good.
function quotaTimeout(error: JobError, config: QueueConfig): JobError {
  return {
    code: 'quota_timeout',
    message: `Deferred for more than ${config.jobMaxAgeHours} hours (last error ${error.code}: ${error.message})`,
    ...(error.providerReason === undefined ? {} : { providerReason: error.providerReason }),
    ...(error.httpStatus === undefined ? {} : { httpStatus: error.httpStatus }),
    retryable: false,
  };
}

function exceedsMaxAge(job: JobDoc, runAt: Date, config: QueueConfig): boolean {
  const since = (job.requeuedAt ?? job.createdAt).getTime();
  return runAt.getTime() - since > config.jobMaxAgeHours * HOUR_MS;
}

// Applies a handler outcome to a running job. Every write is fenced on status, lease owner and attempt
// number, so an outcome that arrives after cancellation, lease expiry or a reclaim is dropped (null).
export async function settleRun(
  job: JobDoc,
  result: RunResult,
  decision: LaneDecision | null,
  ctx: SettleContext,
): Promise<Settled | null> {
  const { now, config } = ctx;
  const fence = runFence(job, ctx.owner);

  switch (result.kind) {
    case 'succeeded':
      return settled(await apply(fence, succeededUpdate(result, now)));

    case 'failed':
      return settled(await apply(fence, failedUpdate(result.error, result.audit, now)));

    case 'cancelled':
      return settled(await apply(fence, cancelledUpdate(now)));

    case 'retry': {
      if (job.attempts >= maxAttemptsFor(job, result.error)) {
        return settled(await apply(fence, failedUpdate({ ...result.error, retryable: false }, result.audit, now)));
      }
      const runAt = new Date(now.getTime() + backoffMs(job.attempts, config, ctx.random));
      return settled(await apply(fence, requeueUpdate(result.error, result.audit, runAt, now)));
    }

    case 'defer': {
      const runAt = decision?.pausedUntil ?? result.runAt ?? new Date(now.getTime() + config.backoffBaseMs);
      if (exceedsMaxAge(job, runAt, config)) {
        return settled(await apply(fence, failedUpdate(quotaTimeout(result.error, config), result.audit, now)));
      }
      const update = requeueUpdate(result.error, result.audit, runAt, now);
      // The claim counted this attempt; a deferral gives it back.
      return settled(await apply(fence, { ...update, $inc: { attempts: -1, deferrals: 1 } }));
    }

    case 'awaiting_operation':
      return settled(
        await apply(fence, {
          $set: {
            status: 'awaiting_operation',
            operation: { name: result.operation.name, submittedAt: now, nextPollAt: result.operation.nextPollAt, polls: 0 },
            ...auditFields(result.audit),
          },
          $unset: { lease: 1, error: 1 },
        }),
      );

    case 'interrupted':
      return settled(await apply(fence, { $set: { status: 'queued', runAt: now }, $inc: { attempts: -1 }, $unset: { lease: 1 } }));
  }
}

// Applies the result of one poll of an awaiting_operation job.
export async function settlePoll(
  job: JobDoc,
  result: PollResult,
  decision: LaneDecision | null,
  ctx: SettleContext,
): Promise<Settled | null> {
  const { now, config } = ctx;
  const fence = pollFence(job, ctx.owner);
  const nextPoll = (at: Date, extra: Update = {}): Update => ({
    $set: { 'operation.nextPollAt': at, ...extra.$set },
    $inc: { 'operation.polls': 1, ...extra.$inc },
    $unset: { lease: 1 },
  });

  switch (result.kind) {
    case 'succeeded':
      return settled(await apply(fence, succeededUpdate(result, now)));

    case 'failed':
      return settled(await apply(fence, failedUpdate(result.error, result.audit, now)));

    case 'cancelled':
      return settled(await apply(fence, cancelledUpdate(now)));

    case 'awaiting_operation':
      return settled(
        await apply(fence, nextPoll(result.operation.nextPollAt, { $set: { 'operation.name': result.operation.name, ...auditFields(result.audit) } })),
      );

    case 'repoll':
      return settled(await apply(fence, nextPoll(result.nextPollAt)));

    case 'defer': {
      const at = decision?.pausedUntil ?? result.runAt ?? new Date(now.getTime() + config.videoPollIntervalMs);
      return settled(
        await apply(fence, nextPoll(at, { $set: { error: errorDoc(result.error, now) }, $inc: { deferrals: 1 } })),
      );
    }

    case 'retry': {
      if (job.attempts >= maxAttemptsFor(job, result.error)) {
        return settled(await apply(fence, failedUpdate({ ...result.error, retryable: false }, result.audit, now)));
      }
      const runAt = new Date(now.getTime() + backoffMs(job.attempts, config, ctx.random));
      const update = requeueUpdate(result.error, result.audit, runAt, now);
      return settled(await apply(fence, { ...update, $unset: { ...update.$unset, operation: 1 } }));
    }
  }
}

export async function failPollTimeout(job: JobDoc, maxWaitMinutes: number, ctx: SettleContext): Promise<Settled | null> {
  const error: JobError = {
    code: 'timeout',
    message: `Operation did not finish within ${maxWaitMinutes} minutes`,
    retryable: false,
  };
  return settled(await apply(pollFence(job, ctx.owner), failedUpdate(error, undefined, ctx.now)));
}

// The poll lane refused a token: put the job back, due again at the lane's reopen time.
export async function deferPoll(job: JobDoc, until: Date, owner: string): Promise<void> {
  await JobModel.updateOne(pollFence(job, owner), { $set: { 'operation.nextPollAt': until }, $unset: { lease: 1 } });
}
