import type { BatchCounts, BatchDelay, BatchStatus, ItemStatus, LanePauseReason } from '@rs/shared';
import { clockTime } from './format';

// The tone values of `s-badge` and `s-progress` in @shopify/polaris-types.
export type PolarisTone = 'auto' | 'neutral' | 'info' | 'success' | 'caution' | 'warning' | 'critical';

const BATCH_TONES: Record<BatchStatus, PolarisTone> = {
  queued: 'neutral',
  running: 'info',
  completed: 'success',
  completed_with_errors: 'warning',
  failed: 'critical',
  cancelled: 'neutral',
};

const BATCH_LABELS: Record<BatchStatus, string> = {
  queued: 'Queued',
  running: 'Running',
  completed: 'Completed',
  completed_with_errors: 'With errors',
  failed: 'Failed',
  cancelled: 'Cancelled',
};

const ITEM_TONES: Record<ItemStatus, PolarisTone> = {
  pending: 'neutral',
  planning: 'info',
  generating: 'info',
  completed: 'success',
  partial: 'warning',
  failed: 'critical',
  cancelled: 'neutral',
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

// Tone for the status badge and the progress bar of a batch.
export const batchTone = (status: BatchStatus): PolarisTone => BATCH_TONES[status];
export const batchLabel = (status: BatchStatus): string => BATCH_LABELS[status];
export const itemTone = (status: ItemStatus): PolarisTone => ITEM_TONES[status];
export const itemLabel = (status: ItemStatus): string => ITEM_LABELS[status];

export function isItemActive(status: ItemStatus): boolean {
  return status === 'pending' || status === 'planning' || status === 'generating';
}

// Jobs in a terminal state over all jobs of the batch, 0 to 1: the `value` of an `s-progress` with the default max.
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

// The text of the delay banner of a batch detail, with the resume time in the viewer's local time.
export function delayBannerText(delay: BatchDelay): string {
  return delayMessage(delay.reason, clockTime(delay.resumesAt));
}
