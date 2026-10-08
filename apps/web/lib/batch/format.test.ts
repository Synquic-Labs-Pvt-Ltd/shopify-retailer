import { describe, expect, it } from 'vitest';
import { clockTime, formatDuration, plural, relativeTime } from './format';

const NOW = Date.parse('2026-03-10T12:00:00.000Z');
const ago = (ms: number): string => new Date(NOW - ms).toISOString();
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

describe('plural', () => {
  it('uses the singular only for exactly one', () => {
    expect(plural(1, 'product')).toBe('1 product');
    expect(plural(0, 'product')).toBe('0 products');
    expect(plural(2, 'product')).toBe('2 products');
    expect(plural(3, 'batch', 'batches')).toBe('3 batches');
    expect(plural(1, 'batch', 'batches')).toBe('1 batch');
  });
});

describe('relativeTime', () => {
  it.each([
    [0, 'just now'],
    [44_999, 'just now'],
    [-5 * MIN, 'just now'],
    [45_000, '1 min ago'],
    [5 * MIN, '5 min ago'],
    [59 * MIN, '59 min ago'],
    [HOUR, '1 h ago'],
    [3 * HOUR, '3 h ago'],
    [23 * HOUR, '23 h ago'],
    [DAY, 'yesterday'],
    [47 * HOUR, 'yesterday'],
    [2 * DAY, '2 days ago'],
    [30 * DAY, '30 days ago'],
  ])('%i ms old -> %s', (ageMs, expected) => {
    expect(relativeTime(ago(ageMs), NOW)).toBe(expected);
  });

  it('treats an unparsable timestamp as just now', () => {
    expect(relativeTime('not a date', NOW)).toBe('just now');
  });
});

describe('formatDuration', () => {
  it.each([
    [0, '0:00'],
    [8, '0:08'],
    [8.4, '0:08'],
    [8.6, '0:09'],
    [59.6, '1:00'],
    [60, '1:00'],
    [75, '1:15'],
    [600, '10:00'],
    [-3, '0:00'],
  ])('%d s -> %s', (seconds, expected) => {
    expect(formatDuration(seconds)).toBe(expected);
  });
});

describe('clockTime', () => {
  it('formats hours and minutes in the local time zone', () => {
    const iso = '2026-03-10T15:45:00.000Z';
    const expected = new Date(iso).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
    expect(clockTime(iso)).toBe(expected);
    expect(clockTime(iso)).toMatch(/^\d{1,2}[:.]\d{2}/);
  });
});
