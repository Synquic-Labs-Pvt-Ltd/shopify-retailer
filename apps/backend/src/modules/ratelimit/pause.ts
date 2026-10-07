import type { LanePauseReason } from '@rs/shared';
import type { LaneFailure } from './index';
import { nextDailyReset } from './windows';

export const RATE_LIMIT_BASE_PAUSE_MS = 10_000;
export const RATE_LIMIT_MAX_PAUSE_MS = 300_000;
export const UNAVAILABLE_PAUSE_MS = 15 * 60_000;

export interface PausePlan {
  reason: LanePauseReason;
  until: Date;
}

// 10 s x 2^n capped at 300 s, where n is the number of consecutive 429s before this one.
export function rateLimitBackoffMs(consecutiveBefore: number): number {
  const exponent = Math.min(Math.max(consecutiveBefore, 0), 16);
  return Math.min(RATE_LIMIT_BASE_PAUSE_MS * 2 ** exponent, RATE_LIMIT_MAX_PAUSE_MS);
}

// The SPEC 11.2 lane pause table. Returns null for classes that never pause a lane.
export function planPause(
  failure: LaneFailure,
  now: Date,
  consecutiveBefore: number,
  dailyResetTimeZone: string,
): PausePlan | null {
  switch (failure.kind) {
    case 'rate_limited': {
      const delay = Math.max(failure.retryDelayMs ?? 0, rateLimitBackoffMs(consecutiveBefore));
      return { reason: 'rate_limited', until: new Date(now.getTime() + delay) };
    }
    case 'daily_quota':
      return { reason: 'daily_quota', until: nextDailyReset(now, dailyResetTimeZone) };
    case 'provider_unavailable':
      return { reason: 'provider_unavailable', until: new Date(now.getTime() + UNAVAILABLE_PAUSE_MS) };
    case 'auth_error':
      return { reason: 'auth_error', until: new Date(now.getTime() + UNAVAILABLE_PAUSE_MS) };
    case 'transient':
    case 'invalid_request':
    case 'safety_blocked':
    case 'no_output':
      return null;
  }
}

const MAX_ERROR_BODY_BYTES = 4096;

// Truncates to 4 KB of UTF-8 without leaving a broken trailing character.
export function truncateErrorBody(body: string): string {
  const bytes = Buffer.from(body, 'utf8');
  if (bytes.length <= MAX_ERROR_BODY_BYTES) return body;
  return bytes.subarray(0, MAX_ERROR_BODY_BYTES).toString('utf8').replace(/�+$/, '');
}
