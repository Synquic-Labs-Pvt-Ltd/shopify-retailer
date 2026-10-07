import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { AiErrorKind } from '@rs/shared';
import { createRateLimitModule, type AcquireResult, type Governor, type LaneFailure } from '../../src/modules/ratelimit';
import { JobModel } from '../../src/modules/queue/models';
import { LaneStateModel, RateCounterModel } from '../../src/modules/ratelimit/models';
import { MONGO_START_TIMEOUT_MS, startTestMongo, type TestMongo } from '../helpers/mongo';
import {
  captureLogger,
  createClock,
  createConfigHolder,
  ERROR_LEVEL,
  insertJob,
  openLane,
  type CapturedLog,
  type ConfigHolder,
  type TestClock,
} from '../queue/kit';

let mongo: TestMongo;
let clock: TestClock;
let cfg: ConfigHolder;
let governor: Governor;
let logs: CapturedLog[];
let ensureIndexes: () => Promise<void>;

beforeAll(async () => {
  mongo = await startTestMongo('rs_ratelimit');
}, MONGO_START_TIMEOUT_MS);

afterAll(async () => {
  await mongo.stop();
});

beforeEach(async () => {
  await mongo.clear();
  clock = createClock();
  cfg = createConfigHolder({ 'test:lane': openLane() });
  const captured = captureLogger();
  logs = captured.lines;
  const service = createRateLimitModule({ getConfig: cfg.get, logger: captured.logger, now: clock.now });
  governor = service.governor;
  ensureIndexes = service.ensureIndexes;
});

const failure = (kind: AiErrorKind, extra: Partial<LaneFailure> = {}): LaneFailure => ({
  kind,
  retryDelayMs: null,
  rawBody: null,
  ...extra,
});

async function acquireMany(lane: string, count: number): Promise<AcquireResult[]> {
  const results: AcquireResult[] = [];
  for (let i = 0; i < count; i += 1) results.push(await governor.acquire(lane));
  return results;
}

const grantedCount = (results: AcquireResult[]): number => results.filter((r) => r.granted).length;

async function counts(): Promise<Record<string, number>> {
  const docs = await RateCounterModel.find().lean();
  return Object.fromEntries(docs.map((doc) => [doc._id, doc.count]));
}

describe('window math and effective limits', () => {
  it('grants floor(rpm x safetyFactor) per minute, then denies until the next UTC minute', async () => {
    cfg.lanes['test:lane'] = openLane({ rpm: 10, safetyFactor: 0.9 });
    clock.set('2026-10-07T12:00:20.000Z');

    const results = await acquireMany('test:lane', 12);
    expect(grantedCount(results)).toBe(9);
    const denied = results[9];
    expect(denied).toEqual({ granted: false, reason: 'window', reopensAt: new Date('2026-10-07T12:01:00.000Z') });

    clock.set('2026-10-07T12:01:00.000Z');
    expect((await governor.acquire('test:lane')).granted).toBe(true);
  });

  it('stores one counter per window with a lane|window|windowStartISO id and a TTL of window end + 1 h', async () => {
    cfg.lanes['test:lane'] = openLane({ rpm: 10, rph: 100, rpd: 1000, dailyResetTimeZone: 'America/Los_Angeles' });
    clock.set('2026-10-07T12:34:56.000Z');
    await governor.acquire('test:lane');

    const docs = await RateCounterModel.find().sort({ _id: 1 }).lean();
    expect(docs.map((d) => d._id)).toEqual([
      'test:lane|day|2026-10-07T07:00:00.000Z',
      'test:lane|hour|2026-10-07T12:00:00.000Z',
      'test:lane|minute|2026-10-07T12:34:00.000Z',
    ]);
    const byWindow = Object.fromEntries(docs.map((d) => [d.window, d]));
    expect(byWindow.day?.expiresAt.toISOString()).toBe('2026-10-08T08:00:00.000Z');
    expect(byWindow.hour?.expiresAt.toISOString()).toBe('2026-10-07T14:00:00.000Z');
    expect(byWindow.minute?.expiresAt.toISOString()).toBe('2026-10-07T13:35:00.000Z');
    expect(docs.every((d) => d.count === 1 && d.lane === 'test:lane')).toBe(true);
  });

  it('creates the TTL index on expiresAt', async () => {
    await ensureIndexes();
    const indexes = await RateCounterModel.collection.indexes();
    const ttl = indexes.find((index) => index.key.expiresAt === 1);
    expect(ttl?.expireAfterSeconds).toBe(0);
  });

  it('resets the day window at local midnight in the lane time zone', async () => {
    cfg.lanes['test:lane'] = openLane({ rpd: 2, dailyResetTimeZone: 'America/Los_Angeles' });
    clock.set('2026-10-08T06:59:00.000Z');
    expect(grantedCount(await acquireMany('test:lane', 3))).toBe(2);

    const denied = await governor.acquire('test:lane');
    expect(denied).toEqual({ granted: false, reason: 'window', reopensAt: new Date('2026-10-08T07:00:00.000Z') });

    clock.set('2026-10-08T07:00:00.000Z');
    expect((await governor.acquire('test:lane')).granted).toBe(true);
  });

  it('uses the 23 hour spring-forward day in America/Los_Angeles', async () => {
    cfg.lanes['test:lane'] = openLane({ rpd: 1, dailyResetTimeZone: 'America/Los_Angeles' });
    clock.set('2026-03-08T12:00:00.000Z');
    await governor.acquire('test:lane');
    const denied = await governor.acquire('test:lane');
    expect(denied).toEqual({ granted: false, reason: 'window', reopensAt: new Date('2026-03-09T07:00:00.000Z') });
    expect(Object.keys(await counts())).toEqual(['test:lane|day|2026-03-08T08:00:00.000Z']);
  });

  it('uses the 25 hour fall-back day in America/Los_Angeles', async () => {
    cfg.lanes['test:lane'] = openLane({ rpd: 1, dailyResetTimeZone: 'America/Los_Angeles' });
    clock.set('2026-11-01T20:00:00.000Z');
    await governor.acquire('test:lane');
    const denied = await governor.acquire('test:lane');
    expect(denied).toEqual({ granted: false, reason: 'window', reopensAt: new Date('2026-11-02T08:00:00.000Z') });
    expect(Object.keys(await counts())).toEqual(['test:lane|day|2026-11-01T07:00:00.000Z']);
  });

  it('treats a null limit as unlimited and creates no counter for it', async () => {
    cfg.lanes['test:lane'] = openLane({ rpm: 5 });
    await governor.acquire('test:lane');
    expect(Object.keys(await counts())).toEqual(['test:lane|minute|2026-10-07T12:00:00.000Z']);
  });

  it('grants without touching the database counters for a lane with no limits at all', async () => {
    expect(await governor.acquire('test:lane')).toEqual({ granted: true, tokens: { counterIds: [] } });
    expect(await counts()).toEqual({});
  });
});

describe('atomic conditional increment', () => {
  it('never over-grants under parallel acquires', async () => {
    cfg.lanes['test:lane'] = openLane({ rpm: 10, safetyFactor: 0.9 });
    const results = await Promise.all(Array.from({ length: 40 }, () => governor.acquire('test:lane')));
    expect(grantedCount(results)).toBe(9);
    expect(Object.values(await counts())).toEqual([9]);
  });
});

describe('rollback on partial denial', () => {
  it('gives the day token back when the hour window refuses', async () => {
    cfg.lanes['test:lane'] = openLane({ rpd: 100, rph: 3, rpm: 50 });
    clock.set('2026-10-07T12:10:00.000Z');
    await acquireMany('test:lane', 3);

    const denied = await governor.acquire('test:lane');
    expect(denied).toEqual({ granted: false, reason: 'window', reopensAt: new Date('2026-10-07T13:00:00.000Z') });
    expect(await counts()).toEqual({
      'test:lane|day|2026-10-07T00:00:00.000Z': 3,
      'test:lane|hour|2026-10-07T12:00:00.000Z': 3,
      'test:lane|minute|2026-10-07T12:10:00.000Z': 3,
    });
  });

  it('gives the day and hour tokens back when the minute window refuses', async () => {
    cfg.lanes['test:lane'] = openLane({ rpd: 100, rph: 100, rpm: 2 });
    await acquireMany('test:lane', 2);

    const denied = await governor.acquire('test:lane');
    expect(denied).toEqual({ granted: false, reason: 'window', reopensAt: new Date('2026-10-07T12:01:00.000Z') });
    expect(await counts()).toEqual({
      'test:lane|day|2026-10-07T00:00:00.000Z': 2,
      'test:lane|hour|2026-10-07T12:00:00.000Z': 2,
      'test:lane|minute|2026-10-07T12:00:00.000Z': 2,
    });
  });

  it('refuses on the day window first and reports the day reset as the reopen time', async () => {
    cfg.lanes['test:lane'] = openLane({ rpd: 1, rph: 100, rpm: 100 });
    await governor.acquire('test:lane');
    const denied = await governor.acquire('test:lane');
    expect(denied).toEqual({ granted: false, reason: 'window', reopensAt: new Date('2026-10-08T00:00:00.000Z') });
    expect(await counts()).toEqual({
      'test:lane|day|2026-10-07T00:00:00.000Z': 1,
      'test:lane|hour|2026-10-07T12:00:00.000Z': 1,
      'test:lane|minute|2026-10-07T12:00:00.000Z': 1,
    });
  });
});

describe('release', () => {
  it('gives a token back so the next acquire succeeds', async () => {
    cfg.lanes['test:lane'] = openLane({ rpm: 2, rph: 10 });
    const first = await governor.acquire('test:lane');
    await governor.acquire('test:lane');
    expect((await governor.acquire('test:lane')).granted).toBe(false);

    await governor.release('test:lane', first.granted ? first.tokens : undefined);
    expect((await governor.acquire('test:lane')).granted).toBe(true);
  });

  it('returns the token to the window it was taken from, even after the minute rolled over', async () => {
    cfg.lanes['test:lane'] = openLane({ rpm: 5 });
    clock.set('2026-10-07T12:00:59.000Z');
    const grant = await governor.acquire('test:lane');
    clock.set('2026-10-07T12:01:01.000Z');
    await governor.acquire('test:lane');

    await governor.release('test:lane', grant.granted ? grant.tokens : undefined);
    expect(await counts()).toEqual({
      'test:lane|minute|2026-10-07T12:00:00.000Z': 0,
      'test:lane|minute|2026-10-07T12:01:00.000Z': 1,
    });
  });

  it('without a grant it releases the current windows and never goes below zero', async () => {
    cfg.lanes['test:lane'] = openLane({ rpm: 5, rph: 5 });
    await governor.acquire('test:lane');
    await governor.release('test:lane');
    await governor.release('test:lane');
    expect(Object.values(await counts())).toEqual([0, 0]);
  });
});

describe('concurrency gate', () => {
  it('denies when running plus awaiting_operation jobs of the lane reach maxConcurrent, without spending a token', async () => {
    cfg.lanes['test:lane'] = openLane({ rpm: 100, maxConcurrent: 2 });
    await insertJob({ lane: 'test:lane', status: 'running' });
    await insertJob({ lane: 'test:lane', status: 'awaiting_operation' });
    await insertJob({ lane: 'test:lane', status: 'queued' });
    await insertJob({ lane: 'test:lane', status: 'succeeded' });
    await insertJob({ lane: 'other:lane', status: 'running' });

    const denied = await governor.acquire('test:lane');
    expect(denied).toMatchObject({ granted: false, reason: 'concurrency' });
    expect(await counts()).toEqual({});
  });

  it('grants again once an in-flight job finishes', async () => {
    cfg.lanes['test:lane'] = openLane({ maxConcurrent: 2 });
    const running = await insertJob({ lane: 'test:lane', status: 'running' });
    await insertJob({ lane: 'test:lane', status: 'awaiting_operation' });
    expect((await governor.acquire('test:lane')).granted).toBe(false);

    await JobModel.updateOne({ _id: running._id }, { $set: { status: 'succeeded' } });
    expect((await governor.acquire('test:lane')).granted).toBe(true);
  });

  it('a null maxConcurrent means unlimited', async () => {
    for (let i = 0; i < 5; i += 1) await insertJob({ lane: 'test:lane', status: 'running' });
    expect((await governor.acquire('test:lane')).granted).toBe(true);
  });

  it('can use an injected in-flight counter', async () => {
    const injected = createRateLimitModule({
      getConfig: () => ({ ...cfg.get(), lanes: { 'test:lane': openLane({ maxConcurrent: 1 }) } }),
      logger: captureLogger().logger,
      now: clock.now,
      countInFlight: async () => 1,
    }).governor;
    expect(await injected.acquire('test:lane')).toMatchObject({ granted: false, reason: 'concurrency' });
  });
});

describe('live config and lane resolution', () => {
  it('lowering rpm applies on the very next acquire', async () => {
    cfg.lanes['test:lane'] = openLane({ rpm: 10 });
    expect(grantedCount(await acquireMany('test:lane', 4))).toBe(4);

    cfg.lanes['test:lane'] = openLane({ rpm: 2 });
    expect((await governor.acquire('test:lane')).granted).toBe(false);

    cfg.lanes['test:lane'] = openLane({ rpm: 5 });
    expect((await governor.acquire('test:lane')).granted).toBe(true);
  });

  it('resolves fake:* for any fake lane', async () => {
    cfg.lanes['fake:*'] = openLane({ rpm: 1 });
    expect((await governor.acquire('fake:gemini')).granted).toBe(true);
    expect((await governor.acquire('fake:gemini')).granted).toBe(false);
  });

  it('keeps separate counters per lane', async () => {
    cfg.lanes['test:a'] = openLane({ rpm: 1 });
    cfg.lanes['test:b'] = openLane({ rpm: 1 });
    expect((await governor.acquire('test:a')).granted).toBe(true);
    expect((await governor.acquire('test:b')).granted).toBe(true);
    expect((await governor.acquire('test:a')).granted).toBe(false);
  });

  it('denies a lane that has no config entry and logs it once per minute', async () => {
    const denied = await governor.acquire('unknown:model');
    expect(denied).toMatchObject({ granted: false, reason: 'paused' });
    await governor.acquire('unknown:model');
    expect(logs.filter((line) => line.level === ERROR_LEVEL && line.lane === 'unknown:model')).toHaveLength(1);
  });
});

describe('lane pause table (SPEC 11.2)', () => {
  it('rate_limited without RetryInfo pauses 10 s, then 20 s, 40 s ... capped at 300 s', async () => {
    const seen: number[] = [];
    for (let i = 0; i < 8; i += 1) {
      const decision = await governor.recordFailure('test:lane', failure('rate_limited'));
      expect(decision.pausedUntil).not.toBeNull();
      seen.push((decision.pausedUntil as Date).getTime() - clock.now().getTime());
      clock.set(decision.pausedUntil as Date);
    }
    expect(seen).toEqual([10_000, 20_000, 40_000, 80_000, 160_000, 300_000, 300_000, 300_000]);
    const state = await LaneStateModel.findById('test:lane').lean();
    expect(state?.consecutiveRateLimits).toBe(8);
    expect(state?.reason).toBe('rate_limited');
  });

  it('rate_limited takes the larger of RetryInfo and the backoff', async () => {
    const big = await governor.recordFailure('test:lane', failure('rate_limited', { retryDelayMs: 45_000 }));
    expect(big.pausedUntil?.toISOString()).toBe('2026-10-07T12:00:45.000Z');

    clock.set('2026-10-07T12:01:00.000Z');
    const small = await governor.recordFailure('test:lane', failure('rate_limited', { retryDelayMs: 1_000 }));
    expect(small.pausedUntil?.toISOString()).toBe('2026-10-07T12:01:20.000Z');
  });

  it('a success resets the consecutive count and records lastSuccessAt', async () => {
    await governor.recordFailure('test:lane', failure('rate_limited'));
    clock.advance(11_000);
    await governor.recordFailure('test:lane', failure('rate_limited'));
    clock.advance(21_000);
    await governor.recordSuccess('test:lane');

    const state = await LaneStateModel.findById('test:lane').lean();
    expect(state?.consecutiveRateLimits).toBe(0);
    expect(state?.lastSuccessAt?.toISOString()).toBe(clock.now().toISOString());

    const next = await governor.recordFailure('test:lane', failure('rate_limited'));
    expect(next.pausedUntil?.getTime()).toBe(clock.now().getTime() + 10_000);
  });

  it('a failure while the lane is already paused does not escalate the backoff', async () => {
    const first = await governor.recordFailure('test:lane', failure('rate_limited'));
    clock.advance(2_000);
    const sibling = await governor.recordFailure('test:lane', failure('rate_limited'));
    expect(sibling.pausedUntil?.toISOString()).toBe(first.pausedUntil?.toISOString());
    expect((await LaneStateModel.findById('test:lane').lean())?.consecutiveRateLimits).toBe(1);

    const withRetryInfo = await governor.recordFailure('test:lane', failure('rate_limited', { retryDelayMs: 60_000 }));
    expect(withRetryInfo.pausedUntil?.toISOString()).toBe('2026-10-07T12:01:02.000Z');
  });

  it('daily_quota pauses until the next daily reset of the lane time zone', async () => {
    cfg.lanes['test:la'] = openLane({ dailyResetTimeZone: 'America/Los_Angeles' });
    const la = await governor.recordFailure('test:la', failure('daily_quota'));
    expect(la.pausedUntil?.toISOString()).toBe('2026-10-08T07:00:00.000Z');
    const utc = await governor.recordFailure('test:lane', failure('daily_quota'));
    expect(utc.pausedUntil?.toISOString()).toBe('2026-10-08T00:00:00.000Z');
    expect((await LaneStateModel.findById('test:la').lean())?.reason).toBe('daily_quota');
  });

  it.each(['provider_unavailable', 'auth_error'] as const)('%s pauses 15 minutes and logs the raw body at error level', async (kind) => {
    const rawBody = '{"error":{"code":403,"status":"PERMISSION_DENIED","message":"Billing disabled"}}';
    const decision = await governor.recordFailure('test:lane', failure(kind, { rawBody }));
    expect(decision.pausedUntil?.toISOString()).toBe('2026-10-07T12:15:00.000Z');

    const state = await LaneStateModel.findById('test:lane').lean();
    expect(state?.reason).toBe(kind);
    expect(state?.lastErrorBody).toBe(rawBody);
    const logged = logs.find((line) => line.level === ERROR_LEVEL && line.lane === 'test:lane');
    expect(logged?.rawBody).toBe(rawBody);
  });

  it.each(['transient', 'invalid_request', 'safety_blocked', 'no_output'] as const)('%s never pauses the lane', async (kind) => {
    const decision = await governor.recordFailure('test:lane', failure(kind, { rawBody: '{"x":1}' }));
    expect(decision).toEqual({ pausedUntil: null });
    expect(await governor.pausedUntil('test:lane')).toBeNull();
    expect(await governor.listPaused()).toEqual([]);
    expect((await governor.acquire('test:lane')).granted).toBe(true);
  });

  it('truncates the stored error body to 4 KB', async () => {
    await governor.recordFailure('test:lane', failure('provider_unavailable', { rawBody: 'x'.repeat(10_000) }));
    const state = await LaneStateModel.findById('test:lane').lean();
    expect(Buffer.byteLength(state?.lastErrorBody ?? '', 'utf8')).toBe(4096);
    expect(state?.lastErrorAt?.toISOString()).toBe(clock.now().toISOString());
  });

  it('a shorter pause never replaces a longer one or its reason', async () => {
    await governor.recordFailure('test:lane', failure('daily_quota'));
    const later = await governor.recordFailure('test:lane', failure('rate_limited', { retryDelayMs: 30_000 }));
    expect(later.pausedUntil?.toISOString()).toBe('2026-10-08T00:00:00.000Z');
    const state = await LaneStateModel.findById('test:lane').lean();
    expect(state?.reason).toBe('daily_quota');
    expect(state?.pausedUntil?.toISOString()).toBe('2026-10-08T00:00:00.000Z');
  });

  it('acquire is denied as paused without spending a token, and reopens at pausedUntil', async () => {
    cfg.lanes['test:lane'] = openLane({ rpm: 10 });
    const decision = await governor.recordFailure('test:lane', failure('rate_limited'));

    const denied = await governor.acquire('test:lane');
    expect(denied).toEqual({ granted: false, reason: 'paused', reopensAt: decision.pausedUntil });
    expect(await counts()).toEqual({});

    clock.set(decision.pausedUntil as Date);
    expect((await governor.acquire('test:lane')).granted).toBe(true);
  });

  it('listPaused and pausedUntil report only lanes that are still paused', async () => {
    await governor.recordFailure('test:lane', failure('provider_unavailable'));
    await governor.recordFailure('test:other', failure('rate_limited'));

    const paused = await governor.listPaused();
    expect(paused.map((p) => [p.lane, p.reason, p.consecutiveRateLimits])).toEqual([
      ['test:lane', 'provider_unavailable', 0],
      ['test:other', 'rate_limited', 1],
    ]);
    expect((await governor.pausedUntil('test:other'))?.toISOString()).toBe('2026-10-07T12:00:10.000Z');

    clock.advance(11_000);
    expect((await governor.listPaused()).map((p) => p.lane)).toEqual(['test:lane']);
    expect(await governor.pausedUntil('test:other')).toBeNull();
  });
});
