import { BATCH_STATUSES, ITEM_STATUSES, LANE_PAUSE_REASONS, type BatchCounts } from '@rs/shared';
import { describe, expect, it } from 'vitest';
import { clockTime } from './format';
import {
  batchLabel,
  batchProgress,
  batchTone,
  delayBannerText,
  delayMessage,
  isItemActive,
  itemLabel,
  itemTone,
  type PolarisTone,
} from './status';

const POLARIS_TONES: readonly PolarisTone[] = ['auto', 'neutral', 'info', 'success', 'caution', 'warning', 'critical'];

function counts(partial: Partial<BatchCounts>): BatchCounts {
  return {
    products: 2,
    jobsTotal: 8,
    jobsSucceeded: 0,
    jobsFailed: 0,
    jobsCancelled: 0,
    imagesReady: 0,
    videosReady: 0,
    ...partial,
  };
}

describe('batch and item badges', () => {
  it('maps every batch status to a Polaris tone and a label', () => {
    expect(BATCH_STATUSES.map((status) => [status, batchTone(status), batchLabel(status)])).toEqual([
      ['queued', 'neutral', 'Queued'],
      ['running', 'info', 'Running'],
      ['completed', 'success', 'Completed'],
      ['completed_with_errors', 'warning', 'With errors'],
      ['failed', 'critical', 'Failed'],
      ['cancelled', 'neutral', 'Cancelled'],
    ]);
  });

  it('maps every item status to a Polaris tone and a label', () => {
    expect(ITEM_STATUSES.map((status) => [status, itemTone(status), itemLabel(status)])).toEqual([
      ['pending', 'neutral', 'Pending'],
      ['planning', 'info', 'Planning'],
      ['generating', 'info', 'Generating'],
      ['completed', 'success', 'Completed'],
      ['partial', 'warning', 'Partial'],
      ['failed', 'critical', 'Failed'],
      ['cancelled', 'neutral', 'Cancelled'],
    ]);
  });

  it('only returns tones that s-badge accepts', () => {
    for (const status of BATCH_STATUSES) expect(POLARIS_TONES).toContain(batchTone(status));
    for (const status of ITEM_STATUSES) expect(POLARIS_TONES).toContain(itemTone(status));
  });

  it('treats pending, planning and generating as active', () => {
    expect(ITEM_STATUSES.filter(isItemActive)).toEqual(['pending', 'planning', 'generating']);
  });
});

describe('batchProgress', () => {
  it('is the share of jobs in a terminal state', () => {
    expect(batchProgress(counts({}))).toBe(0);
    expect(batchProgress(counts({ jobsSucceeded: 2 }))).toBe(0.25);
    expect(batchProgress(counts({ jobsSucceeded: 3, jobsFailed: 1, jobsCancelled: 2 }))).toBe(0.75);
    expect(batchProgress(counts({ jobsSucceeded: 7, jobsFailed: 1 }))).toBe(1);
  });

  it('is 0 for a batch without jobs and never above 1', () => {
    expect(batchProgress(counts({ jobsTotal: 0 }))).toBe(0);
    expect(batchProgress(counts({ jobsTotal: 4, jobsSucceeded: 9 }))).toBe(1);
  });
});

describe('delay banner', () => {
  it('names the pause reason and the time of the next check', () => {
    expect(delayMessage('rate_limited', '3:45 PM')).toBe('Provider busy, resumes around 3:45 PM.');
    expect(delayMessage('daily_quota', '9:00 AM')).toBe(
      'Daily generation limit reached. Generation continues automatically around 9:00 AM.',
    );
    expect(delayMessage('provider_unavailable', '1:00 PM')).toBe(
      'The AI service is unavailable right now. Jobs keep retrying automatically; next check around 1:00 PM.',
    );
    expect(delayMessage('auth_error', '1:00 PM')).toBe(delayMessage('provider_unavailable', '1:00 PM'));
  });

  it('covers every lane pause reason and always shows the time', () => {
    for (const reason of LANE_PAUSE_REASONS) expect(delayMessage(reason, 'x')).toMatch(/ around x\.$/);
  });

  it('formats the resume time of a delay in local time', () => {
    const resumesAt = '2026-03-10T15:45:00.000Z';
    expect(delayBannerText({ reason: 'rate_limited', resumesAt })).toBe(
      `Provider busy, resumes around ${clockTime(resumesAt)}.`,
    );
    expect(delayBannerText({ reason: 'daily_quota', resumesAt })).toBe(
      `Daily generation limit reached. Generation continues automatically around ${clockTime(resumesAt)}.`,
    );
  });
});
