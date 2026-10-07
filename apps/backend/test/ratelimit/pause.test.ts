import { describe, expect, it } from 'vitest';
import { planPause, rateLimitBackoffMs, truncateErrorBody } from '../../src/modules/ratelimit/pause';

const now = new Date('2026-10-07T12:00:00.000Z');
const failure = (kind: Parameters<typeof planPause>[0]['kind'], retryDelayMs: number | null = null) => ({
  kind,
  retryDelayMs,
  rawBody: null,
});

describe('rateLimitBackoffMs', () => {
  it('is 10 s x 2^n capped at 300 s', () => {
    expect([0, 1, 2, 3, 4, 5, 6, 40].map(rateLimitBackoffMs)).toEqual([10_000, 20_000, 40_000, 80_000, 160_000, 300_000, 300_000, 300_000]);
  });
});

describe('planPause (SPEC 11.2 table)', () => {
  it('rate_limited: max(retryDelay, backoff)', () => {
    expect(planPause(failure('rate_limited'), now, 0, 'UTC')).toEqual({
      reason: 'rate_limited',
      until: new Date('2026-10-07T12:00:10.000Z'),
    });
    expect(planPause(failure('rate_limited', 45_000), now, 0, 'UTC')?.until.toISOString()).toBe('2026-10-07T12:00:45.000Z');
    expect(planPause(failure('rate_limited', 5_000), now, 2, 'UTC')?.until.toISOString()).toBe('2026-10-07T12:00:40.000Z');
  });

  it('rate_limited: a RetryInfo delay above the cap is honoured', () => {
    expect(planPause(failure('rate_limited', 600_000), now, 0, 'UTC')?.until.toISOString()).toBe('2026-10-07T12:10:00.000Z');
  });

  it('daily_quota: next reset in the lane time zone', () => {
    expect(planPause(failure('daily_quota'), now, 0, 'America/Los_Angeles')).toEqual({
      reason: 'daily_quota',
      until: new Date('2026-10-08T07:00:00.000Z'),
    });
    expect(planPause(failure('daily_quota'), now, 0, 'UTC')?.until.toISOString()).toBe('2026-10-08T00:00:00.000Z');
  });

  it.each(['provider_unavailable', 'auth_error'] as const)('%s: 15 minutes', (kind) => {
    expect(planPause(failure(kind), now, 0, 'UTC')).toEqual({ reason: kind, until: new Date('2026-10-07T12:15:00.000Z') });
  });

  it.each(['transient', 'invalid_request', 'safety_blocked', 'no_output'] as const)('%s: no lane pause', (kind) => {
    expect(planPause(failure(kind), now, 0, 'UTC')).toBeNull();
  });
});

describe('truncateErrorBody', () => {
  it('keeps short bodies as they are', () => {
    expect(truncateErrorBody('{"error":1}')).toBe('{"error":1}');
  });

  it('cuts to 4 KB of UTF-8', () => {
    const cut = truncateErrorBody('a'.repeat(10_000));
    expect(Buffer.byteLength(cut, 'utf8')).toBe(4096);
  });

  it('never leaves half a character behind', () => {
    const cut = truncateErrorBody('€'.repeat(3000));
    expect(Buffer.byteLength(cut, 'utf8')).toBeLessThanOrEqual(4096);
    expect(cut).not.toContain('�');
  });
});
