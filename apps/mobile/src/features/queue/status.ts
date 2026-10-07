import type { BatchCounts, BatchStatus, ItemStatus, LanePauseReason } from '@rs/shared';
import type { Tone } from '../../design';

const BATCH_TONES: Record<BatchStatus, Tone> = {
  queued: 'pending',
  running: 'neutral',
  completed: 'success',
  completed_with_errors: 'warning',
  failed: 'danger',
  cancelled: 'pending',
};

const BATCH_LABELS: Record<BatchStatus, string> = {
  queued: 'Queued',
  running: 'Running',
  completed: 'Completed',
  completed_with_errors: 'With errors',
  failed: 'Failed',
  cancelled: 'Cancelled',
};

const ITEM_TONES: Record<ItemStatus, Tone> = {
  pending: 'pending',
  planning: 'neutral',
  generating: 'neutral',
  completed: 'success',
  partial: 'warning',
  failed: 'danger',
  cancelled: 'pending',
};

const ITEM_LABELS: Record<ItemStatus, string> = {
  pending: 'Pending',
  planning: 'Planning',
  generating: 'Generating',
  completed: 'Completed',
  partial: 'Partial',
  failed: 'Failed',
  cancelled: 'Cancelled',
};

export const batchTone = (status: BatchStatus): Tone => BATCH_TONES[status];
export const batchLabel = (status: BatchStatus): string => BATCH_LABELS[status];
export const itemTone = (status: ItemStatus): Tone => ITEM_TONES[status];
export const itemLabel = (status: ItemStatus): string => ITEM_LABELS[status];

export function isItemActive(status: ItemStatus): boolean {
  return status === 'pending' || status === 'planning' || status === 'generating';
}

// Jobs in a terminal state over all jobs of the batch, 0 to 1.
export function batchProgress(counts: BatchCounts): number {
  if (counts.jobsTotal === 0) return 0;
  const finished = counts.jobsSucceeded + counts.jobsFailed + counts.jobsCancelled;
  return Math.min(1, finished / counts.jobsTotal);
}

const DELAY_PREFIX: Record<LanePauseReason, string> = {
  rate_limited: 'Provider busy',
  daily_quota: 'Daily limit reached',
  provider_unavailable: 'Provider unavailable',
  auth_error: 'Provider unavailable',
};

// SPEC 11.2: "Provider busy, resumes around {time}".
export function delayMessage(reason: LanePauseReason, resumesAtLabel: string): string {
  return `${DELAY_PREFIX[reason]}, resumes around ${resumesAtLabel}.`;
}
