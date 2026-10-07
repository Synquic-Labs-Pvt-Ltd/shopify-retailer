import type { RateWindow } from '@rs/shared';

export interface WindowBounds {
  start: Date;
  end: Date;
}

const MINUTE_MS = 60_000;
const HOUR_MS = 3_600_000;
const COUNTER_TTL_GRACE_MS = HOUR_MS;

// Offsets of real zones stay within -12:00..+14:00, which bounds the search for a local midnight.
const SEARCH_BEFORE_MS = 15 * HOUR_MS;
const SEARCH_AFTER_MS = 13 * HOUR_MS;

const formatters = new Map<string, Intl.DateTimeFormat>();
const dayStartCache = new Map<string, number>();
const DAY_START_CACHE_LIMIT = 512;

function formatterFor(timeZone: string): Intl.DateTimeFormat {
  let formatter = formatters.get(timeZone);
  if (formatter === undefined) {
    formatter = new Intl.DateTimeFormat('en-US', { timeZone, year: 'numeric', month: 'numeric', day: 'numeric' });
    formatters.set(timeZone, formatter);
  }
  return formatter;
}

// Local calendar date of an instant as a comparable integer: yyyymmdd.
function localDateKey(timeZone: string, ms: number): number {
  let year = 0;
  let month = 0;
  let day = 0;
  for (const part of formatterFor(timeZone).formatToParts(ms)) {
    if (part.type === 'year') year = Number(part.value);
    else if (part.type === 'month') month = Number(part.value);
    else if (part.type === 'day') day = Number(part.value);
  }
  return year * 10_000 + month * 100 + day;
}

function nextDateKey(key: number): number {
  const year = Math.floor(key / 10_000);
  const month = Math.floor((key % 10_000) / 100);
  const day = key % 100;
  const next = new Date(Date.UTC(year, month - 1, day + 1));
  return next.getUTCFullYear() * 10_000 + (next.getUTCMonth() + 1) * 100 + next.getUTCDate();
}

// The first instant whose local date is at or after the given date. Binary search on a monotonic
// function, so it is exact across DST gaps and overlaps without any offset arithmetic.
function firstInstantOfDate(timeZone: string, key: number): number {
  const cacheKey = `${timeZone}|${key}`;
  const cached = dayStartCache.get(cacheKey);
  if (cached !== undefined) return cached;

  const approx = Date.UTC(Math.floor(key / 10_000), Math.floor((key % 10_000) / 100) - 1, key % 100);
  let low = approx - SEARCH_BEFORE_MS;
  let high = approx + SEARCH_AFTER_MS;
  while (high - low > 1) {
    const mid = low + Math.floor((high - low) / 2);
    if (localDateKey(timeZone, mid) >= key) high = mid;
    else low = mid;
  }

  if (dayStartCache.size >= DAY_START_CACHE_LIMIT) dayStartCache.clear();
  dayStartCache.set(cacheKey, high);
  return high;
}

function alignedBounds(at: Date, sizeMs: number): WindowBounds {
  const start = Math.floor(at.getTime() / sizeMs) * sizeMs;
  return { start: new Date(start), end: new Date(start + sizeMs) };
}

function dayBounds(at: Date, timeZone: string): WindowBounds {
  const key = localDateKey(timeZone, at.getTime());
  return {
    start: new Date(firstInstantOfDate(timeZone, key)),
    end: new Date(firstInstantOfDate(timeZone, nextDateKey(key))),
  };
}

// Minute and hour windows are aligned to UTC; the day window starts at local midnight in the lane's zone.
export function windowBounds(window: RateWindow, at: Date, timeZone: string): WindowBounds {
  switch (window) {
    case 'minute':
      return alignedBounds(at, MINUTE_MS);
    case 'hour':
      return alignedBounds(at, HOUR_MS);
    case 'day':
      return dayBounds(at, timeZone);
  }
}

export function nextDailyReset(at: Date, timeZone: string): Date {
  return dayBounds(at, timeZone).end;
}

export function counterId(lane: string, window: RateWindow, start: Date): string {
  return `${lane}|${window}|${start.toISOString()}`;
}

// TTL for counter documents: window end plus one hour.
export function counterExpiry(bounds: WindowBounds): Date {
  return new Date(bounds.end.getTime() + COUNTER_TTL_GRACE_MS);
}

// floor(limit x safetyFactor), never below 1 so a tiny limit cannot lock a lane forever.
// The epsilon absorbs binary floating point error such as 0.58 x 100 = 57.999...
export function effectiveLimit(limit: number, safetyFactor: number): number {
  return Math.max(1, Math.floor(limit * safetyFactor + 1e-9));
}
