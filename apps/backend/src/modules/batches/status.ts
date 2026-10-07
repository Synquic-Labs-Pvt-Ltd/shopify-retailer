import { isTerminalJobStatus, type BatchStatus, type ItemStatus, type JobStatus, type JobType } from '@rs/shared';

// Pure aggregation rules (SPEC 10.5). Counters and statuses are derived from the jobs themselves, so the
// result is the same however often, and in whatever order, job completions are reported.

export interface JobFact {
  type: JobType;
  status: JobStatus;
  outputIndex: number | null;
  mediaId: string | null;
}

export interface ItemState {
  status: ItemStatus;
  // The creative plan exists (planner or fallback), so output jobs can already run.
  planned: boolean;
  // Jobs created for the item. Terminal states are only derived once all of them exist.
  expectedJobs: number;
}

export interface ItemDerivation {
  counts: { succeeded: number; failed: number; cancelled: number };
  // null: leave the stored status alone (pending and planning are set by the handlers).
  status: ItemStatus | null;
  terminal: boolean;
  outputMediaIds: string[];
}

const TERMINAL_ITEM_STATUSES: readonly ItemStatus[] = ['completed', 'partial', 'failed', 'cancelled'];

export function isTerminalItemStatus(status: ItemStatus): boolean {
  return TERMINAL_ITEM_STATUSES.includes(status);
}

function count(jobs: readonly JobFact[], status: JobStatus): number {
  return jobs.filter((job) => job.status === status).length;
}

// Images first, then videos, each by outputIndex.
function outputIds(jobs: readonly JobFact[]): string[] {
  return jobs
    .filter((job) => job.type !== 'plan' && job.status === 'succeeded' && job.mediaId !== null)
    .sort((a, b) => (a.type === b.type ? 0 : a.type === 'image' ? -1 : 1) || (a.outputIndex ?? 0) - (b.outputIndex ?? 0))
    .flatMap((job) => (job.mediaId === null ? [] : [job.mediaId]));
}

function terminalItemStatus(jobs: readonly JobFact[]): ItemStatus {
  // A failed plan does not block outputs (the fallback plan runs), so the outputs decide the item status.
  const outputs = jobs.filter((job) => job.type !== 'plan');
  const basis = outputs.length > 0 ? outputs : jobs;
  const succeeded = count(basis, 'succeeded');
  if (succeeded === basis.length) return 'completed';
  if (count(jobs, 'cancelled') > 0) return 'cancelled';
  return succeeded > 0 ? 'partial' : 'failed';
}

function liveItemStatus(jobs: readonly JobFact[], state: ItemState): ItemStatus | null {
  const plan = jobs.find((job) => job.type === 'plan');
  const planTerminal = plan === undefined || isTerminalJobStatus(plan.status);
  const outputsOpen = jobs.some((job) => job.type !== 'plan' && !isTerminalJobStatus(job.status));
  if (outputsOpen && (planTerminal || state.planned)) return 'generating';
  if (planTerminal) return null;
  // The plan is open again (retry) or never ran: pending and planning stay as the handlers set them.
  return state.status === 'pending' || state.status === 'planning' ? null : 'planning';
}

export function deriveItem(jobs: readonly JobFact[], state: ItemState): ItemDerivation {
  const counts = { succeeded: count(jobs, 'succeeded'), failed: count(jobs, 'failed'), cancelled: count(jobs, 'cancelled') };
  const complete = jobs.length > 0 && jobs.length >= state.expectedJobs;
  const terminal = complete && jobs.every((job) => isTerminalJobStatus(job.status));
  const status = terminal ? terminalItemStatus(jobs) : liveItemStatus(jobs, state);
  return { counts, status, terminal, outputMediaIds: outputIds(jobs) };
}

export interface BatchState {
  status: BatchStatus;
  expectedJobs: number;
}

export interface BatchDerivation {
  counts: { jobsSucceeded: number; jobsFailed: number; jobsCancelled: number; imagesReady: number; videosReady: number };
  // null: leave the stored status alone (queued becomes running through markBatchStarted).
  status: BatchStatus | null;
  terminal: boolean;
}

function terminalBatchStatus(itemStatuses: readonly ItemStatus[], outputs: number): BatchStatus {
  if (itemStatuses.includes('cancelled')) return 'cancelled';
  if (itemStatuses.every((status) => status === 'completed')) return 'completed';
  return outputs > 0 ? 'completed_with_errors' : 'failed';
}

// itemStatuses are the item statuses after applying deriveItem.
export function deriveBatch(jobs: readonly JobFact[], itemStatuses: readonly ItemStatus[], state: BatchState): BatchDerivation {
  const succeeded = (type: JobType): number => jobs.filter((job) => job.type === type && job.status === 'succeeded' && job.mediaId !== null).length;
  const counts = {
    jobsSucceeded: count(jobs, 'succeeded'),
    jobsFailed: count(jobs, 'failed'),
    jobsCancelled: count(jobs, 'cancelled'),
    imagesReady: succeeded('image'),
    videosReady: succeeded('video'),
  };
  const complete = jobs.length > 0 && jobs.length >= state.expectedJobs;
  const terminal = complete && jobs.every((job) => isTerminalJobStatus(job.status));
  if (terminal) {
    return { counts, terminal, status: terminalBatchStatus(itemStatuses, counts.imagesReady + counts.videosReady) };
  }
  const wasTerminal = state.status !== 'queued' && state.status !== 'running';
  return { counts, terminal, status: wasTerminal ? 'running' : null };
}
