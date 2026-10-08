import type { ClassifiedError } from '../ai';
import type { JobAudit, JobError, JobOutcome, QueueJob } from '../queue';
import type { LaneFailure } from '../ratelimit';

export function toJobError(error: ClassifiedError): JobError {
  return {
    code: error.kind,
    message: error.message,
    retryable: error.retryable,
    ...(error.providerReason === null ? {} : { providerReason: error.providerReason }),
    ...(error.httpStatus === null ? {} : { httpStatus: error.httpStatus }),
  };
}

function toLaneFailure(error: ClassifiedError): LaneFailure {
  return { kind: error.kind, retryDelayMs: error.retryDelayMs, rawBody: error.rawBody };
}

// SPEC 11.2: what a handler returns for each class of provider error. The runner applies the lane pause
// (from laneFailure) and the attempt accounting.
export function outcomeFromAiError(error: ClassifiedError, audit?: JobAudit): JobOutcome {
  const jobError = toJobError(error);
  const laneFailure = toLaneFailure(error);
  const extras = audit === undefined ? { laneFailure } : { laneFailure, audit };
  switch (error.kind) {
    case 'rate_limited':
    case 'daily_quota':
    case 'provider_unavailable':
    case 'auth_error':
      // The lane is paused and the job waits for it without spending an attempt.
      return { kind: 'defer', error: { ...jobError, retryable: true }, ...extras };
    case 'transient':
    case 'no_output':
      return { kind: 'retry', error: { ...jobError, retryable: true }, ...extras };
    case 'invalid_request':
    case 'safety_blocked':
      return { kind: 'failed', error: { ...jobError, retryable: false }, ...extras };
  }
}

// True when the job already ran once into a safety block, so this run uses the safer presentation (no person).
export const isSafeAttempt = (job: QueueJob): boolean => job.error?.code === 'safety_blocked';

// Image and video jobs: the first safety block is retried once with the safer presentation instead of failing the
// product's output; a second block fails the job as before. The retry uses an attempt and the usual backoff.
// alreadySafe says the run that was blocked already used the safer presentation. For a submit that is read from the job's
// last error; a poll must pass its own answer, because a successful submit clears that error.
export function outcomeFromGenerationError(
  error: ClassifiedError,
  job: QueueJob,
  audit?: JobAudit,
  alreadySafe: boolean = isSafeAttempt(job),
): JobOutcome {
  const outcome = outcomeFromAiError(error, audit);
  if (error.kind !== 'safety_blocked' || outcome.kind !== 'failed' || alreadySafe) return outcome;
  return { ...outcome, kind: 'retry', error: { ...outcome.error, retryable: true } };
}

// Errors that are the handler's own, not the provider's.
export function failure(code: JobError['code'], message: string, retryable: boolean): JobError {
  return { code, message, retryable };
}
