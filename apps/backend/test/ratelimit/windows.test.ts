import { describe, expect, it } from 'vitest';
import { counterExpiry, counterId, effectiveLimit, nextDailyReset, windowBounds } from '../../src/modules/ratelimit/windows';

const iso = (date: Date): string => date.toISOString();
const HOUR = 3_600_000;

describe('minute and hour windows', () => {
  const at = new Date('2026-10-07T12:34:56.789Z');

  it('align to the UTC minute and hour', () => {
    const minute = windowBounds('minute', at, 'America/Los_Angeles');
    expect(iso(minute.start)).toBe('2026-10-07T12:34:00.000Z');
    expect(iso(minute.end)).toBe('2026-10-07T12:35:00.000Z');
    const hour = windowBounds('hour', at, 'Asia/Kolkata');
    expect(iso(hour.start)).toBe('2026-10-07T12:00:00.000Z');
    expect(iso(hour.end)).toBe('2026-10-07T13:00:00.000Z');
  });

  it('start exactly on a boundary belongs to the new window', () => {
    const minute = windowBounds('minute', new Date('2026-10-07T12:35:00.000Z'), 'UTC');
    expect(iso(minute.start)).toBe('2026-10-07T12:35:00.000Z');
  });
});

describe('day window', () => {
  it('is UTC midnight for a UTC lane', () => {
    const day = windowBounds('day', new Date('2026-10-07T23:59:59.999Z'), 'UTC');
    expect(iso(day.start)).toBe('2026-10-07T00:00:00.000Z');
    expect(iso(day.end)).toBe('2026-10-08T00:00:00.000Z');
  });

  it('is local midnight in America/Los_Angeles', () => {
    const day = windowBounds('day', new Date('2026-10-07T12:00:00Z'), 'America/Los_Angeles');
    expect(iso(day.start)).toBe('2026-10-07T07:00:00.000Z');
    expect(iso(day.end)).toBe('2026-10-08T07:00:00.000Z');
  });

  it('rolls over exactly at local midnight', () => {
    const before = windowBounds('day', new Date('2026-10-08T06:59:59.999Z'), 'America/Los_Angeles');
    const after = windowBounds('day', new Date('2026-10-08T07:00:00.000Z'), 'America/Los_Angeles');
    expect(iso(before.start)).toBe('2026-10-07T07:00:00.000Z');
    expect(iso(after.start)).toBe('2026-10-08T07:00:00.000Z');
    expect(iso(before.end)).toBe(iso(after.start));
  });

  it('spring forward in Los Angeles makes a 23 hour day', () => {
    const day = windowBounds('day', new Date('2026-03-08T12:00:00Z'), 'America/Los_Angeles');
    expect(iso(day.start)).toBe('2026-03-08T08:00:00.000Z');
    expect(iso(day.end)).toBe('2026-03-09T07:00:00.000Z');
    expect((day.end.getTime() - day.start.getTime()) / HOUR).toBe(23);
  });

  it('fall back in Los Angeles makes a 25 hour day', () => {
    const day = windowBounds('day', new Date('2026-11-01T20:00:00Z'), 'America/Los_Angeles');
    expect(iso(day.start)).toBe('2026-11-01T07:00:00.000Z');
    expect(iso(day.end)).toBe('2026-11-02T08:00:00.000Z');
    expect((day.end.getTime() - day.start.getTime()) / HOUR).toBe(25);
  });

  it('the days around the DST switch are contiguous and have the right length', () => {
    const lengths: number[] = [];
    let cursor = new Date('2026-03-07T12:00:00Z');
    let previousEnd: Date | null = null;
    for (let i = 0; i < 4; i += 1) {
      const day = windowBounds('day', cursor, 'America/Los_Angeles');
      if (previousEnd !== null) expect(iso(day.start)).toBe(iso(previousEnd));
      lengths.push((day.end.getTime() - day.start.getTime()) / HOUR);
      previousEnd = day.end;
      cursor = day.end;
    }
    expect(lengths).toEqual([24, 23, 24, 24]);
  });

  it('handles a half-hour offset zone', () => {
    const day = windowBounds('day', new Date('2026-10-07T20:00:00Z'), 'Asia/Kolkata');
    expect(iso(day.start)).toBe('2026-10-07T18:30:00.000Z');
    expect(iso(day.end)).toBe('2026-10-08T18:30:00.000Z');
  });

  it('starts the day at the transition when local midnight does not exist', () => {
    // Cuba springs forward at 00:00 local, so 2026-03-08 begins at 01:00 CDT = 05:00Z.
    const day = windowBounds('day', new Date('2026-03-08T12:00:00Z'), 'America/Havana');
    expect(iso(day.start)).toBe('2026-03-08T05:00:00.000Z');
    expect(iso(day.end)).toBe('2026-03-09T04:00:00.000Z');
  });

  it('nextDailyReset is the end of the current day window', () => {
    expect(iso(nextDailyReset(new Date('2026-10-07T12:00:00Z'), 'America/Los_Angeles'))).toBe('2026-10-08T07:00:00.000Z');
    expect(iso(nextDailyReset(new Date('2026-10-07T12:00:00Z'), 'UTC'))).toBe('2026-10-08T00:00:00.000Z');
  });
});

describe('counter documents', () => {
  it('uses lane|window|windowStartISO ids and expires one hour after the window ends', () => {
    const bounds = windowBounds('minute', new Date('2026-10-07T12:34:56Z'), 'UTC');
    expect(counterId('vertex:poll', 'minute', bounds.start)).toBe('vertex:poll|minute|2026-10-07T12:34:00.000Z');
    expect(iso(counterExpiry(bounds))).toBe('2026-10-07T13:35:00.000Z');
  });
});

describe('effectiveLimit', () => {
  it('is floor(limit x safetyFactor)', () => {
    expect(effectiveLimit(10, 0.9)).toBe(9);
    expect(effectiveLimit(4, 0.9)).toBe(3);
    expect(effectiveLimit(300, 0.9)).toBe(270);
    expect(effectiveLimit(60, 0.5)).toBe(30);
  });

  it('is not hurt by floating point error', () => {
    expect(effectiveLimit(100, 0.58)).toBe(58);
  });

  it('never drops below 1', () => {
    expect(effectiveLimit(1, 0.9)).toBe(1);
  });
});
