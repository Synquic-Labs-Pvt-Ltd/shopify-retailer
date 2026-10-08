import type { BatchListResponse, BatchStatus, BatchSummary } from '@rs/shared';
import { ApiError, BATCH_STATUSES } from '@rs/shared';
import { describe, expect, it } from 'vitest';
import {
  BATCH_DETAIL_POLL_MS,
  BATCH_LIST_POLL_MS,
  batchDetailPollInterval,
  batchListPollInterval,
  pollNotice,
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

const NETWORK = new ApiError(0, 'network_error', 'Cannot reach the server');
const TIMEOUT = new ApiError(0, 'timeout', 'Too slow');
const UNAVAILABLE = new ApiError(503, 'service_unavailable', 'Down');
const RATE_LIMITED = new ApiError(429, 'too_many_requests', 'Slow down');
const TRANSIENT = [NETWORK, TIMEOUT, UNAVAILABLE, RATE_LIMITED];
const UNAUTHORIZED = new ApiError(401, 'unauthorized', 'Reopen the app');
const NOT_FOUND = new ApiError(404, 'not_found', 'Gone');
const INTERNAL = new ApiError(500, 'internal', 'Boom');
const PERMANENT = [UNAUTHORIZED, NOT_FOUND, INTERNAL];

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

  it('keeps polling after a failed poll that may pass, and stops for one that will not', () => {
    for (const error of TRANSIENT) expect(batchListPollInterval([page('running')], true, error)).toBe(8000);
    for (const error of PERMANENT) expect(batchListPollInterval([page('running')], true, error)).toBe(false);
    expect(batchListPollInterval([page('running')], true, null)).toBe(8000);
    expect(batchListPollInterval([page('running')], true, undefined)).toBe(8000);
  });
});

describe('batchDetailPollInterval', () => {
  it('polls every 4 s until the batch is terminal', () => {
    for (const status of BATCH_STATUSES) {
      const terminal = ['completed', 'completed_with_errors', 'failed', 'cancelled'].includes(status);
      expect(batchDetailPollInterval({ status, error: null }, true)).toBe(terminal ? false : BATCH_DETAIL_POLL_MS);
    }
  });

  it('keeps polling after a failed refresh that may pass (network, timeout, outage) while data is loaded', () => {
    for (const error of TRANSIENT) {
      expect(batchDetailPollInterval({ status: 'running', error }, true)).toBe(4000);
    }
  });

  it('stops polling after a failure that will not pass, such as a 401', () => {
    for (const error of PERMANENT) {
      expect(batchDetailPollInterval({ status: 'running', error }, true)).toBe(false);
    }
  });

  it('polls before the first response but stops if that load failed', () => {
    expect(batchDetailPollInterval({ status: undefined }, true)).toBe(4000);
    expect(batchDetailPollInterval({ status: undefined, error: null }, true)).toBe(4000);
    expect(batchDetailPollInterval({ status: undefined, error: NETWORK }, true)).toBe(false);
    expect(batchDetailPollInterval({ status: undefined, error: UNAUTHORIZED }, true)).toBe(false);
  });

  it('stops while the document is hidden', () => {
    expect(batchDetailPollInterval({ status: 'running' }, false)).toBe(false);
  });

  it('does not poll a finished batch, whatever the last request did', () => {
    expect(batchDetailPollInterval({ status: 'completed', error: NETWORK }, true)).toBe(false);
  });
});

describe('pollNotice', () => {
  it('is none while the poll works or nothing is loaded yet', () => {
    expect(pollNotice({ hasData: true, error: null })).toBe('none');
    expect(pollNotice({ hasData: true, error: undefined, failureReason: null })).toBe('none');
    expect(pollNotice({ hasData: false, error: NETWORK })).toBe('none');
    expect(pollNotice({ hasData: false, error: null, failureReason: NETWORK })).toBe('none');
  });

  it('says reconnecting while data is on screen and the failure may pass', () => {
    for (const error of TRANSIENT) expect(pollNotice({ hasData: true, error })).toBe('reconnecting');
  });

  it('says reconnecting while a failed attempt is being retried', () => {
    expect(pollNotice({ hasData: true, error: null, failureReason: UNAVAILABLE })).toBe('reconnecting');
  });

  it('says stopped for a failure that will not pass', () => {
    for (const error of PERMANENT) expect(pollNotice({ hasData: true, error })).toBe('stopped');
  });

  it('prefers the error of the last request over the attempt being retried', () => {
    expect(pollNotice({ hasData: true, error: UNAUTHORIZED, failureReason: NETWORK })).toBe('stopped');
  });
});
