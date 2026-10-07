import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { batchSummarySchema, healthResponseSchema, type MediaObject } from '@rs/shared';
import { FAKE_JPEG } from '../../src/modules/ai/fake-media';
import { BatchModel } from '../../src/modules/batches/models';
import { JobModel } from '../../src/modules/queue/models';
import { LaneStateModel, RateCounterModel } from '../../src/modules/ratelimit/models';
import { commonImageSpec, createBatch, defined, getBatch, login, uploadReadyReferences, type ApiClient } from './support/client';
import { MONGO_START_TIMEOUT_MS, startE2e, type E2e } from './support/harness';
import { sleep } from './support/wait';

const SHOP = 'paced-store.myshopify.com';
const PLANNER_LANE = 'fake:gemini-2.5-flash';

let e2e: E2e;
let client: ApiClient;
let reference: MediaObject;
let gids: string[] = [];

beforeAll(async () => {
  e2e = await startE2e({ dbName: 'rs_e2e_rate' });
  e2e.stub.addShop(SHOP);
  client = await login(e2e, SHOP);
  gids = e2e.stub.shop(SHOP).products.map((product) => product.id);
  reference = defined((await uploadReadyReferences(client, [commonImageSpec('common', FAKE_JPEG)]))[0]);
}, MONGO_START_TIMEOUT_MS);

afterAll(async () => {
  await e2e.stop();
});

async function newBatch(productCount: number): Promise<string> {
  const res = await createBatch(client, {
    products: gids.slice(0, productCount).map((productGid) => ({ productGid })),
    commonReferenceMediaIds: [reference.id],
  });
  expect(res.status).toBe(201);
  return batchSummarySchema.parse(res.body).id;
}

const planJobs = (batchId: string) => JobModel.find({ batchId, type: 'plan' }).sort({ createdAt: 1, _id: 1 }).lean();

describe('provider 429s', () => {
  it('defers without burning attempts, shows the delay and the paused lane, then finishes after the pause', async () => {
    e2e.editConfig((config) => {
      config.fake.rateLimitProbability = 1;
    });
    const batchId = await newBatch(1);
    const deferred = async (): Promise<boolean> => ((await planJobs(batchId))[0]?.deferrals ?? 0) >= 1;
    await e2e.drive(deferred);
    await e2e.settle();

    const [plan] = await planJobs(batchId);
    expect(plan).toMatchObject({ status: 'queued', attempts: 0, deferrals: 1, error: { code: 'rate_limited', retryable: true } });
    // Classified from the raw body: max(RetryInfo 5 s, 10 s x 2^0) from now.
    const pauseMs = (plan?.runAt.getTime() ?? 0) - Date.now();
    expect(pauseMs).toBeGreaterThan(5_000);
    expect(pauseMs).toBeLessThanOrEqual(10_000);

    const lane = await LaneStateModel.findById(PLANNER_LANE).lean();
    expect(lane).toMatchObject({ reason: 'rate_limited', consecutiveRateLimits: 1 });
    expect(lane?.pausedUntil?.getTime()).toBe(plan?.runAt.getTime());
    expect(lane?.lastErrorBody).toContain('RESOURCE_EXHAUSTED');

    const detail = await getBatch(client, batchId);
    expect(detail.delay).toEqual({ reason: 'rate_limited', resumesAt: plan?.runAt.toISOString() });
    expect(detail.status).not.toBe('failed');
    expect(detail.items[0]?.jobs.map((job) => job.status)).toEqual(['queued', 'blocked', 'blocked', 'blocked']);

    const health = healthResponseSchema.parse((await request(e2e.app).get('/health')).body);
    expect(health.pausedLanes).toEqual([{ lane: PLANNER_LANE, reason: 'rate_limited', pausedUntil: plan?.runAt.toISOString() }]);

    // While the lane is paused the runner leaves the job alone, even though the provider would keep refusing.
    for (let tick = 0; tick < 10; tick += 1) {
      await e2e.tick();
      await sleep(20);
    }
    expect((await planJobs(batchId))[0]).toMatchObject({ status: 'queued', attempts: 0, deferrals: 1 });

    // The operator fixes the quota: the next edit applies at once, and the batch finishes when the pause ends.
    e2e.editConfig((config) => {
      config.fake.rateLimitProbability = 0;
    });
    const batch = await e2e.driveBatch(batchId, { timeoutMs: 45_000 });
    expect(batch.status).toBe('completed');
    await e2e.settle();

    const finished = await getBatch(client, batchId);
    expect(finished).toMatchObject({ status: 'completed', delay: null, counts: { jobsSucceeded: 4, jobsFailed: 0, imagesReady: 2, videosReady: 1 } });
    expect(finished.items[0]?.outputs).toHaveLength(3);
    const jobs = await JobModel.find({ batchId }).lean();
    expect(jobs.every((job) => job.status === 'succeeded' && job.attempts === 1)).toBe(true);
    expect((await planJobs(batchId))[0]?.deferrals).toBe(1);
    expect((await LaneStateModel.findById(PLANNER_LANE).lean())?.consecutiveRateLimits).toBe(0);
    expect(healthResponseSchema.parse((await request(e2e.app).get('/health')).body).pausedLanes).toEqual([]);
  }, 90_000);
});

describe('live lane limits', () => {
  // Minute windows are aligned to the wall clock, so stay clear of a rollover while pacing is observed.
  async function clearOfMinuteEnd(): Promise<void> {
    const seconds = new Date().getUTCSeconds();
    if (seconds >= 45) await sleep((61 - seconds) * 1000);
  }

  it('paces claims with rpm 1, then applies a raised rpm without a restart', async () => {
    await clearOfMinuteEnd();
    // The first test already spent requests in this minute window: start from an empty one.
    await RateCounterModel.deleteMany({});
    e2e.editConfig((config) => {
      const lane = defined(config.lanes['fake:*']);
      lane.rpm = 1;
    });
    const batchId = await newBatch(3);
    const startedPlans = async (): Promise<number> => JobModel.countDocuments({ batchId, type: 'plan', startedAt: { $exists: true } });

    for (let tick = 0; tick < 15; tick += 1) {
      await e2e.tick();
      await sleep(25);
    }
    await e2e.settle();
    expect(await startedPlans()).toBe(1);
    expect(await JobModel.countDocuments({ batchId, type: 'plan', status: 'queued', attempts: 0 })).toBe(2);
    // A refused token is pacing, not a pause: no lane is paused and nothing is delayed.
    expect((await getBatch(client, batchId)).delay).toBeNull();
    expect(healthResponseSchema.parse((await request(e2e.app).get('/health')).body).pausedLanes).toEqual([]);
    const windows = await RateCounterModel.find({ lane: PLANNER_LANE, window: 'minute' }).sort({ windowStart: -1 }).lean();
    expect(windows[0]).toMatchObject({ count: 1 });

    e2e.editConfig((config) => {
      const lane = defined(config.lanes['fake:*']);
      lane.rpm = 600;
    });
    const batch = await e2e.driveBatch(batchId, { timeoutMs: 45_000 });
    expect(batch.status).toBe('completed');
    await e2e.settle();
    expect(await startedPlans()).toBe(3);
    expect(await BatchModel.countDocuments({ _id: batchId, 'counts.jobsSucceeded': 12 })).toBe(1);
    expect((await RateCounterModel.find({ lane: PLANNER_LANE, window: 'minute' }).lean()).every((counter) => counter.count <= 600)).toBe(true);
  }, 120_000);

  it('counts video operations in flight against the lane concurrency', async () => {
    e2e.editConfig((config) => {
      const video = defined(config.lanes[`fake:${config.models.video}`]);
      video.maxConcurrent = 2;
    });
    const batchId = await newBatch(4);
    let mostInFlight = 0;
    const sample = async (): Promise<boolean> => {
      const inFlight = await JobModel.countDocuments({ batchId, type: 'video', status: { $in: ['running', 'awaiting_operation'] } });
      mostInFlight = Math.max(mostInFlight, inFlight);
      return (await BatchModel.findById(batchId).lean())?.status === 'completed';
    };
    await e2e.drive(sample, { timeoutMs: 60_000, intervalMs: 5 });
    await e2e.settle();
    expect(mostInFlight).toBe(2);
    expect(await JobModel.countDocuments({ batchId, type: 'video', status: 'succeeded' })).toBe(4);
    e2e.editConfig((config) => {
      defined(config.lanes[`fake:${config.models.video}`]).maxConcurrent = 50;
    });
  }, 90_000);

  it('rejects an invalid live edit and keeps the last good config', () => {
    const before = e2e.config.get().fake.rateLimitProbability;
    expect(() =>
      e2e.editConfig((config) => {
        config.fake.rateLimitProbability = 2;
      }),
    ).toThrow(/rejected/);
    expect(e2e.config.get().fake.rateLimitProbability).toBe(before);
  });

  it('rejects an edit that leaves a model without a lane, which would stall its jobs without a word', () => {
    expect(() =>
      e2e.editConfig((config) => {
        delete config.lanes['fake:*'];
        delete config.lanes[`fake:${config.models.video}`];
      }),
    ).toThrow(/no lane for fake:gemini-2.5-flash/);
    expect(defined(e2e.config.get().lanes['fake:*']).rpm).toBe(600);
  });
});

describe('logs', () => {
  it('recorded the lane pause and the rejected edit as warnings and nothing worse', () => {
    const expected = ['lane paused', 'generation config rejected, keeping the last good config', 'released blocked jobs whose dependencies were already terminal'];
    expect(e2e.problems(expected)).toEqual([]);
    expect(e2e.logs.some((line) => line.includes('"msg":"lane paused"') && line.includes(PLANNER_LANE))).toBe(true);
  });
});
