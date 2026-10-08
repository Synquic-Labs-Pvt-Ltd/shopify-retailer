import type { BatchListResponse, BatchStatus, BatchSummary } from '@rs/shared';
import { BATCH_STATUSES } from '@rs/shared';
import { describe, expect, it } from 'vitest';
import {
  BATCH_DETAIL_POLL_MS,
  BATCH_LIST_POLL_MS,
  batchDetailPollInterval,
  batchListPollInterval,
} from './batches';
import { mediaPollDelay } from './media';

function summary(status: BatchStatus): BatchSummary {
  return {
    id: '0'.repeat(24),
    status,
    counts: { products: 1, jobsTotal: 4, jobsSucceeded: 0, jobsFailed: 0, jobsCancelled: 0, imagesReady: 0, videosReady: 0 },
    createdAt: '2026-03-01T12:00:00.000Z',
    finishedAt: null,
    coverImageUrl: null,
    configSnapshot: { outputs: { imagesPerProduct: 2, videosPerProduct: 1 } },
  };
}

function page(...statuses: BatchStatus[]): BatchListResponse {
  return { items: statuses.map(summary), pageInfo: { endCursor: null, hasNextPage: false } };
}

describe('mediaPollDelay', () => {
  it('grows by 300 ms per poll from 1.5 s and stops at 3 s', () => {
    expect([0, 1, 2, 3, 4, 5, 6].map(mediaPollDelay)).toEqual([1500, 1800, 2100, 2400, 2700, 3000, 3000]);
    expect(mediaPollDelay(500)).toBe(3000);
  });
});

describe('batchListPollInterval', () => {
  it('polls every 8 s while any loaded batch is queued or running', () => {
    expect(batchListPollInterval([page('completed'), page('completed', 'running')], true)).toBe(BATCH_LIST_POLL_MS);
    expect(batchListPollInterval([page('queued')], true)).toBe(8000);
  });

  it('stops when every loaded batch is terminal or nothing is loaded', () => {
    expect(batchListPollInterval([page('completed', 'completed_with_errors', 'failed', 'cancelled')], true)).toBe(false);
    expect(batchListPollInterval([], true)).toBe(false);
    expect(batchListPollInterval(undefined, true)).toBe(false);
  });

  it('stops while the document is hidden', () => {
    expect(batchListPollInterval([page('running')], false)).toBe(false);
  });
});

describe('batchDetailPollInterval', () => {
  it('polls every 4 s until the batch is terminal', () => {
    for (const status of BATCH_STATUSES) {
      const terminal = ['completed', 'completed_with_errors', 'failed', 'cancelled'].includes(status);
      expect(batchDetailPollInterval({ status, hasError: false }, true)).toBe(terminal ? false : BATCH_DETAIL_POLL_MS);
    }
  });

  it('keeps polling after a failed refresh when data is already loaded', () => {
    expect(batchDetailPollInterval({ status: 'running', hasError: true }, true)).toBe(4000);
  });

  it('polls before the first response but stops if that load failed', () => {
    expect(batchDetailPollInterval({ status: undefined, hasError: false }, true)).toBe(4000);
    expect(batchDetailPollInterval({ status: undefined, hasError: true }, true)).toBe(false);
  });

  it('stops while the document is hidden', () => {
    expect(batchDetailPollInterval({ status: 'running', hasError: false }, false)).toBe(false);
  });
});
