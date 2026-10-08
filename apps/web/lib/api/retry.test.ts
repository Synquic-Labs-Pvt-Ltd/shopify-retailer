import { ApiError } from '@rs/shared';
import { describe, expect, it } from 'vitest';
import {
  GET_RETRY,
  IDEMPOTENT_POST_RETRY,
  NO_RETRY,
  RETRY_AFTER_CAP_MS,
  RETRY_JITTER_MS,
  isTransientError,
  parseRetryAfter,
  queryRetryDelay,
  retryAfterSecOf,
  retryDelayMs,
  shouldRetryQuery,
  shouldRetryRequest,
} from './retry';

const network = new ApiError(0, 'network_error', 'Cannot reach the server');
const timeout = new ApiError(0, 'timeout', 'Too slow');
const unavailable = new ApiError(503, 'service_unavailable', 'Down');
const tooMany = new ApiError(429, 'too_many_requests', 'Slow down', { retryAfterSec: 3 });
const shopLimit = new ApiError(429, 'shop_limit', 'Three batches at a time');
const notFound = new ApiError(404, 'not_found', 'No such batch');
const internal = new ApiError(500, 'internal', 'Boom');

describe('isTransientError', () => {
  it('is true for network, timeout, unavailable and rate limit errors only', () => {
    expect([network, timeout, unavailable, tooMany].map(isTransientError)).toEqual([true, true, true, true]);
    expect([shopLimit, notFound, internal, new Error('x'), null].map(isTransientError)).toEqual([
      false,
      false,
      false,
      false,
      false,
    ]);
  });
});

describe('shouldRetryRequest', () => {
  it('lets a GET retry transient errors twice and never other 4xx or 5xx', () => {
    expect(shouldRetryRequest(GET_RETRY, unavailable, 0)).toBe(true);
    expect(shouldRetryRequest(GET_RETRY, unavailable, 1)).toBe(true);
    expect(shouldRetryRequest(GET_RETRY, unavailable, 2)).toBe(false);
    for (const error of [shopLimit, notFound, internal, new ApiError(401, 'unauthorized', 'No')]) {
      expect(shouldRetryRequest(GET_RETRY, error, 0)).toBe(false);
    }
    expect(shouldRetryRequest(GET_RETRY, new TypeError('x'), 0)).toBe(false);
  });

  it('retries a 429 but not the shop limit, which is also a 429', () => {
    expect(shouldRetryRequest(GET_RETRY, tooMany, 0)).toBe(true);
    expect(shouldRetryRequest(GET_RETRY, shopLimit, 0)).toBe(false);
  });

  it('does not retry without a rule and retries an idempotent POST once, on a lost answer only', () => {
    expect(shouldRetryRequest(NO_RETRY, network, 0)).toBe(false);
    expect(shouldRetryRequest(IDEMPOTENT_POST_RETRY, network, 0)).toBe(true);
    expect(shouldRetryRequest(IDEMPOTENT_POST_RETRY, timeout, 0)).toBe(true);
    expect(shouldRetryRequest(IDEMPOTENT_POST_RETRY, network, 1)).toBe(false);
    expect(shouldRetryRequest(IDEMPOTENT_POST_RETRY, unavailable, 0)).toBe(false);
    expect(shouldRetryRequest(IDEMPOTENT_POST_RETRY, tooMany, 0)).toBe(false);
  });
});

describe('retryDelayMs', () => {
  it('backs off 400 ms, then 1.2 s, plus jitter', () => {
    expect(retryDelayMs(network, 0, () => 0)).toBe(400);
    expect(retryDelayMs(network, 1, () => 0)).toBe(1_200);
    expect(retryDelayMs(network, 0, () => 0.5)).toBe(400 + RETRY_JITTER_MS / 2);
    expect(retryDelayMs(network, 1, () => 0.999)).toBeLessThanOrEqual(1_200 + RETRY_JITTER_MS);
    expect(retryDelayMs(network, 5, () => 0)).toBe(1_200);
  });

  it('honours Retry-After when it is longer than the backoff, capped at 8 s', () => {
    const wait = (retryAfterSec: number) => new ApiError(429, 'too_many_requests', 'x', { retryAfterSec });
    expect(retryDelayMs(wait(3), 0, () => 0)).toBe(3_000);
    expect(retryDelayMs(wait(0.1), 0, () => 0)).toBe(400);
    expect(retryDelayMs(wait(120), 0, () => 0)).toBe(RETRY_AFTER_CAP_MS);
    expect(RETRY_AFTER_CAP_MS).toBe(8_000);
  });
});

describe('retryAfterSecOf', () => {
  it('reads a positive number from the details and nothing else', () => {
    expect(retryAfterSecOf({ retryAfterSec: 4 })).toBe(4);
    expect(retryAfterSecOf({ retryAfterSec: 0 })).toBeNull();
    expect(retryAfterSecOf({ retryAfterSec: '4' })).toBeNull();
    expect(retryAfterSecOf({ retryAfterSec: Number.NaN })).toBeNull();
    expect(retryAfterSecOf({ other: 1 })).toBeNull();
    expect(retryAfterSecOf(undefined)).toBeNull();
    expect(retryAfterSecOf('4')).toBeNull();
  });
});

describe('parseRetryAfter', () => {
  const now = Date.parse('2026-03-10T12:00:00.000Z');

  it('reads seconds, rounding up', () => {
    expect(parseRetryAfter('7', now)).toBe(7);
    expect(parseRetryAfter(' 2.5 ', now)).toBe(3);
  });

  it('reads an HTTP date relative to now', () => {
    expect(parseRetryAfter('Tue, 10 Mar 2026 12:00:30 GMT', now)).toBe(30);
    expect(parseRetryAfter('Tue, 10 Mar 2026 11:00:00 GMT', now)).toBeNull();
  });

  it('is null when absent, empty, zero or garbage', () => {
    for (const header of [null, '', '  ', '0', 'soon', '-3']) expect(parseRetryAfter(header, now)).toBeNull();
  });
});

describe('query retry', () => {
  it('retries a query once more for transient errors and for an envelope 5xx', () => {
    expect(shouldRetryQuery(0, network)).toBe(true);
    expect(shouldRetryQuery(0, timeout)).toBe(true);
    expect(shouldRetryQuery(0, unavailable)).toBe(true);
    expect(shouldRetryQuery(0, tooMany)).toBe(true);
    expect(shouldRetryQuery(0, internal)).toBe(true);
    expect(shouldRetryQuery(1, network)).toBe(false);
  });

  it('never retries a 4xx, an unimplemented endpoint, a bad response or a foreign error', () => {
    for (const error of [
      notFound,
      shopLimit,
      new ApiError(401, 'unauthorized', 'No'),
      new ApiError(422, 'references_required', 'No'),
      new ApiError(501, 'not_implemented', 'No'),
      new ApiError(200, 'invalid_response', 'No'),
      new Error('x'),
    ]) {
      expect(shouldRetryQuery(0, error)).toBe(false);
    }
  });

  it('waits exponentially from 2 s, up to 15 s', () => {
    expect([0, 1, 2, 3, 4].map(queryRetryDelay)).toEqual([2_000, 4_000, 8_000, 15_000, 15_000]);
  });
});
