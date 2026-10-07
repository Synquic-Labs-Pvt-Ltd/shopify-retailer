import type { GenerationConfig, JobErrorCode, JobStatus, JobType } from '@rs/shared';
import type { Logger } from '../../core/logger';
import type { Governor, LaneFailure } from '../ratelimit';

export interface JobError {
  code: JobErrorCode;
  message: string;
  providerReason?: string;
  httpStatus?: number;
  retryable: boolean;
}

export interface JobOperation {
  name: string;
  submittedAt: Date;
  nextPollAt: Date;
  polls: number;
}

export interface JobOutput {
  mediaAssetId: string | null;
  providerResponseId: string | null;
  modelVersion: string | null;
}

export interface QueueJob {
  id: string;
  shopId: string;
  batchId: string;
  batchItemId: string;
  type: JobType;
  lane: string;
  status: JobStatus;
  dependsOn: string[];
  outputIndex: number | null;
  priority: number;
  runAt: Date;
  attempts: number;
  maxAttempts: number;
  deferrals: number;
  operation: JobOperation | null;
  promptVersion: string | null;
  renderedPrompt: string | null;
  output: JobOutput | null;
  error: (JobError & { at: Date }) | null;
  createdAt: Date;
  startedAt: Date | null;
  finishedAt: Date | null;
}

export interface NewJob {
  shopId: string;
  batchId: string;
  batchItemId: string;
  type: JobType;
  lane: string;
  // Ids of jobs created earlier. Non-empty means the job starts blocked.
  dependsOn?: string[];
  outputIndex?: number;
  priority?: number;
}

export interface JobAudit {
  promptVersion?: string;
  renderedPrompt?: string;
}

// What a handler returns. The runner applies the state transition, attempt accounting and backoff.
//
// laneFailure: the classified provider failure behind a failed, retry or defer outcome. The runner
// passes it to governor.recordFailure, which pauses the lane per the SPEC 11.2 table. Every succeeded
// and awaiting_operation outcome is reported to governor.recordSuccess.
//
// For a job that is being polled (handler.poll), the outcomes mean: succeeded, failed and cancelled
// finish the job; awaiting_operation schedules the next poll; defer postpones the next poll to the
// lane's pausedUntil (or runAt) without resubmitting; retry abandons the operation and requeues the
// job for a fresh submit with backoff, consuming no extra attempt beyond the one already taken.
export type JobOutcome =
  | { kind: 'succeeded'; output?: JobOutput; audit?: JobAudit }
  | { kind: 'failed'; error: JobError; audit?: JobAudit; laneFailure?: LaneFailure }
  // Transient failure: requeued with backoff, consumes an attempt.
  | { kind: 'retry'; error: JobError; audit?: JobAudit; laneFailure?: LaneFailure }
  // Lane paused or quota exhausted: requeued, does not consume an attempt. The requeue time is the
  // lane's pausedUntil when laneFailure pauses the lane, otherwise runAt (default now + backoffBaseMs).
  | { kind: 'defer'; error: JobError; runAt?: Date; audit?: JobAudit; laneFailure?: LaneFailure }
  // Long-running operation submitted: releases the worker slot until nextPollAt.
  | { kind: 'awaiting_operation'; operation: { name: string; nextPollAt: Date }; audit?: JobAudit }
  | { kind: 'cancelled' };

export interface JobHandler {
  readonly type: JobType;
  run(job: QueueJob, signal: AbortSignal): Promise<JobOutcome>;
  // Only for job types that return awaiting_operation.
  poll?(job: QueueJob, signal: AbortSignal): Promise<JobOutcome>;
}

export interface JobStore {
  enqueue(job: NewJob): Promise<QueueJob>;
  get(jobId: string): Promise<QueueJob | null>;
  listByBatch(shopId: string, batchId: string): Promise<QueueJob[]>;
  // Blocked, queued and awaiting_operation jobs become cancelled (running jobs finish and keep their
  // output, SPEC 10.5). Returns the number cancelled.
  cancelByBatch(shopId: string, batchId: string): Promise<number>;
  // Cancels every non-terminal job of the shop (uninstall).
  cancelByShop(shopId: string): Promise<number>;
  // Requeues failed jobs of the batch with attempts reset. Returns the number requeued.
  requeueFailed(shopId: string, batchId: string): Promise<number>;
  purgeShop(shopId: string): Promise<void>;
}

export interface QueueRunner {
  registerHandler(handler: JobHandler): void;
  start(): void;
  stop(): Promise<void>;
  readonly lastTickAt: Date | null;
}

export interface QueueService {
  readonly store: JobStore;
  readonly runner: QueueRunner;
}

export interface QueueRunnerControl extends QueueRunner {
  // One full tick: fill every lane, poll due operations, run the reaper when due. start() calls this
  // on a timer; tests call it directly with an injected clock.
  tickOnce(): Promise<void>;
  // Resolves when no handler call started by this runner is still in flight.
  idle(): Promise<void>;
}

export interface QueueModule extends QueueService {
  readonly runner: QueueRunnerControl;
  // Creates the jobs indexes. Mongoose also does this on connect.
  ensureIndexes(): Promise<void>;
}

// Per-call AbortSignal timeouts (SPEC 11.1).
export interface CallTimeoutsMs {
  plan: number;
  image: number;
  videoSubmit: number;
  poll: number;
}

export interface QueueModuleOptions {
  // Read at every use, so queue.* and lanes edits apply without a restart.
  getConfig: () => GenerationConfig;
  governor: Governor;
  logger: Logger;
  // Lease owner. Defaults to hostname:pid:random.
  instanceId?: string;
  now?: () => Date;
  // Called after a job the runner moved reaches succeeded, failed or cancelled (and its dependents
  // were released). Not called for jobs cancelled through JobStore.cancelByBatch or cancelByShop.
  // Errors are logged and swallowed.
  onTerminal?: (job: QueueJob) => void | Promise<void>;
  // Test seams.
  random?: () => number;
  callTimeoutsMs?: Partial<CallTimeoutsMs>;
  reapIntervalMs?: number;
  // How long stop() waits for in-flight handlers before aborting them. Defaults to 10 s.
  shutdownGraceMs?: number;
}

export { createQueueModule } from './module';
