import type { JobErrorCode, JobStatus, JobType } from '@rs/shared';

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
export type JobOutcome =
  | { kind: 'succeeded'; output?: JobOutput; audit?: JobAudit }
  | { kind: 'failed'; error: JobError; audit?: JobAudit }
  // Transient failure: requeued with backoff, consumes an attempt.
  | { kind: 'retry'; error: JobError; audit?: JobAudit }
  // Lane paused or quota exhausted: requeued at runAt, does not consume an attempt.
  | { kind: 'defer'; error: JobError; runAt: Date; audit?: JobAudit }
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
  // Blocked and queued jobs become cancelled. Returns the number cancelled.
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
