import { ApiError, type ApiErrorCode } from '@rs/shared';

// Retry rules of the API client. Two layers cooperate, each with one job:
//  - apiRequest (client.ts) retries transport trouble of GET requests itself, with a short backoff, so a blip never
//    reaches a page;
//  - TanStack Query (providers.tsx) then retries a query once more after a longer pause, which also covers the
//    envelope 5xx answers apiRequest leaves alone.
// Mutations are never retried automatically.

// Failures that may well succeed a moment later.
export const TRANSIENT_ERROR_CODES: readonly ApiErrorCode[] = [
  'network_error',
  'timeout',
  'service_unavailable',
  'too_many_requests',
];

export function isTransientError(error: unknown): boolean {
  return error instanceof ApiError && TRANSIENT_ERROR_CODES.includes(error.code);
}

export interface RetryRule {
  // Extra attempts after the first one.
  retries: number;
  // Error codes that are worth another attempt.
  codes: readonly ApiErrorCode[];
}

export const NO_RETRY: RetryRule = { retries: 0, codes: [] };
export const GET_RETRY: RetryRule = { retries: 2, codes: TRANSIENT_ERROR_CODES };
// For a POST that carries an idempotency key: the server answers a repeat with the same result, so a request whose
// outcome is unknown (the connection dropped, the answer never came) can safely be sent once more.
export const IDEMPOTENT_POST_RETRY: RetryRule = { retries: 1, codes: ['network_error', 'timeout'] };

// Pause before extra attempt 1 and 2.
export const RETRY_BACKOFF_MS: readonly number[] = [400, 1_200];
export const RETRY_JITTER_MS = 200;
// A Retry-After longer than this is not waited out: the page would look frozen.
export const RETRY_AFTER_CAP_MS = 8_000;

// `retriesDone` extra attempts have been made already.
export function shouldRetryRequest(rule: RetryRule, error: unknown, retriesDone: number): boolean {
  return error instanceof ApiError && retriesDone < rule.retries && rule.codes.includes(error.code);
}

// The wait the server asked for ({ retryAfterSec } in the details of a 429 or 503), or null.
export function retryAfterSecOf(details: unknown): number | null {
  if (typeof details !== 'object' || details === null || !('retryAfterSec' in details)) return null;
  const seconds = details.retryAfterSec;
  return typeof seconds === 'number' && Number.isFinite(seconds) && seconds > 0 ? seconds : null;
}

// Backoff of the next attempt: 400 ms, then 1.2 s, plus up to RETRY_JITTER_MS so clients do not retry in step.
// A Retry-After from the server replaces the backoff when it is longer, up to RETRY_AFTER_CAP_MS.
export function retryDelayMs(error: unknown, retriesDone: number, random: () => number): number {
  const index = Math.min(Math.max(retriesDone, 0), RETRY_BACKOFF_MS.length - 1);
  const backoff = RETRY_BACKOFF_MS[index] ?? 0;
  const hinted = error instanceof ApiError ? retryAfterSecOf(error.details) : null;
  const base = hinted === null ? backoff : Math.max(backoff, Math.min(hinted * 1_000, RETRY_AFTER_CAP_MS));
  return Math.round(base + random() * RETRY_JITTER_MS);
}

// Retry-After is either a number of seconds or an HTTP date. Returns whole seconds, or null when absent or invalid.
export function parseRetryAfter(header: string | null, now: number = Date.now()): number | null {
  if (header === null) return null;
  const value = header.trim();
  if (value === '') return null;
  if (/^\d+(\.\d+)?$/.test(value)) {
    const seconds = Math.ceil(Number(value));
    return seconds > 0 ? seconds : null;
  }
  // Date.parse accepts odd strings such as "-3"; a real HTTP date always has a day and month name.
  const at = /[a-z]/i.test(value) ? Date.parse(value) : Number.NaN;
  if (Number.isNaN(at)) return null;
  const seconds = Math.ceil((at - now) / 1_000);
  return seconds > 0 ? seconds : null;
}

// TanStack Query retries a failed query once more, after apiRequest has made its own attempts: transient failures,
// and an envelope 5xx (a blip behind the API can answer 500). Never a 4xx, which a repeat cannot fix.
export const QUERY_EXTRA_RETRIES = 1;

export function shouldRetryQuery(failureCount: number, error: unknown): boolean {
  if (failureCount >= QUERY_EXTRA_RETRIES || !(error instanceof ApiError)) return false;
  if (isTransientError(error)) return true;
  return error.status >= 500 && error.code !== 'not_implemented';
}

// Exponential, from 2 s; apiRequest has already waited 1.6 s by the time a query comes here.
export function queryRetryDelay(failureCount: number): number {
  return Math.min(2_000 * 2 ** Math.max(failureCount, 0), 15_000);
}
