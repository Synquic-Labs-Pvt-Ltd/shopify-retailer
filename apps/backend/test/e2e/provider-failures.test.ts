import { readFileSync } from 'node:fs';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { batchSummarySchema, healthResponseSchema, type MediaObject } from '@rs/shared';
import { FAKE_JPEG } from '../../src/modules/ai/fake-media';
import { classifyAiError, makeAiError } from '../../src/modules/ai';
import { BatchItemModel, BatchModel } from '../../src/modules/batches/models';
import { JobModel } from '../../src/modules/queue/models';
import { LaneStateModel } from '../../src/modules/ratelimit/models';
import { nextDailyReset } from '../../src/modules/ratelimit/windows';
import { commonImageSpec, createBatch, defined, getBatch, login, uploadReadyReferences, type ApiClient } from './support/client';
import { MONGO_START_TIMEOUT_MS, startE2e, type E2e } from './support/harness';

const SHOP = 'flaky-store.myshopify.com';
const PLANNER_LANE = 'fake:gemini-2.5-flash';
const IMAGE_LANE = 'fake:gemini-2.5-flash-image';

let e2e: E2e;
let client: ApiClient;
let reference: MediaObject;
let gids: string[] = [];

const fixture = (name: string): string => readFileSync(new URL(`../../fixtures/ai-errors/${name}`, import.meta.url), 'utf8');
const provider = () => e2e.container.ai.getProvider('fake');

beforeAll(async () => {
  e2e = await startE2e({
    dbName: 'rs_e2e_failures',
    config: (config) => {
      config.queue.maxAttempts = 3;
    },
  });
  e2e.stub.addShop(SHOP);
  client = await login(e2e, SHOP);
  gids = e2e.stub.shop(SHOP).products.map((product) => product.id);
  reference = defined((await uploadReadyReferences(client, [commonImageSpec('common', FAKE_JPEG)]))[0]);
}, MONGO_START_TIMEOUT_MS);

afterEach(() => {
  vi.restoreAllMocks();
});

afterAll(async () => {
  await e2e.stop();
});

async function newBatch(productIndex: number): Promise<string> {
  const res = await createBatch(client, { products: [{ productGid: defined(gids[productIndex]) }], commonReferenceMediaIds: [reference.id] });
  expect(res.status).toBe(201);
  return batchSummarySchema.parse(res.body).id;
}

const paused = async (): Promise<string[]> =>
  healthResponseSchema.parse((await request(e2e.app).get('/health')).body).pausedLanes.map((lane) => `${lane.lane}:${lane.reason}`);

describe('errors that fail or retry a job without pausing a lane (SPEC 11.2)', () => {
  it('fails safety_blocked at once, retries no_output and a transient error, then retry-failed finishes the batch', async () => {
    const images = vi.spyOn(provider(), 'generateImage');
    images.mockImplementationOnce(async () => ({ ok: false, error: makeAiError('safety_blocked', 'The image was blocked', { providerReason: 'IMAGE_SAFETY' }) }));
    images.mockImplementationOnce(async () => ({ ok: false, error: makeAiError('no_output', 'The model returned no image') }));
    vi.spyOn(provider(), 'submitVideo').mockImplementationOnce(async () => ({
      ok: false,
      error: makeAiError('transient', 'HTTP 503 UNAVAILABLE', { httpStatus: 503, providerStatus: 'UNAVAILABLE' }),
    }));

    const batchId = await newBatch(0);
    expect((await e2e.driveBatch(batchId, { timeoutMs: 60_000 })).status).toBe('completed_with_errors');
    await e2e.settle();

    const jobs = await JobModel.find({ batchId }).lean();
    const blocked = jobs.filter((job) => job.status === 'failed');
    expect(blocked).toHaveLength(1);
    expect(blocked[0]).toMatchObject({ type: 'image', attempts: 1, deferrals: 0, error: { code: 'safety_blocked', retryable: false, providerReason: 'IMAGE_SAFETY' } });
    const retriedImage = jobs.filter((job) => job.type === 'image' && job.status === 'succeeded');
    expect(retriedImage).toHaveLength(1);
    expect(retriedImage[0]).toMatchObject({ attempts: 2 });
    expect(retriedImage[0]?.error).toBeUndefined();
    expect(jobs.find((job) => job.type === 'video')).toMatchObject({ status: 'succeeded', attempts: 2 });
    expect(await paused()).toEqual([]);

    const detail = await getBatch(client, batchId);
    expect(detail.items[0]?.status).toBe('partial');
    expect(detail.items[0]?.outputs).toHaveLength(2);
    expect(detail.counts).toMatchObject({ jobsFailed: 1, jobsSucceeded: 3, imagesReady: 1, videosReady: 1 });
    expect(detail.items[0]?.jobs.filter((job) => job.status === 'failed').map((job) => job.errorCode)).toEqual(['safety_blocked']);

    // The provider behaves again: retry-failed gives the blocked shot a fresh run.
    expect((await client.post(`/api/v1/batches/${batchId}/retry-failed`)).status).toBe(200);
    expect((await e2e.driveBatch(batchId, { timeoutMs: 60_000 })).status).toBe('completed');
    await e2e.settle();
    expect((await getBatch(client, batchId)).items[0]?.outputs).toHaveLength(3);
  }, 90_000);

  it('does not retry an invalid request', async () => {
    vi.spyOn(provider(), 'plan').mockImplementationOnce(async () => ({ ok: false, error: classifyAiError(400, fixture('400-invalid-argument.json')) }));
    const batchId = await newBatch(1);
    expect((await e2e.driveBatch(batchId, { timeoutMs: 60_000 })).status).toBe('completed');
    await e2e.settle();
    // A failed plan never blocks the outputs: the fallback plan is used.
    const plan = defined(await JobModel.findOne({ batchId, type: 'plan' }).lean());
    expect(plan).toMatchObject({ status: 'failed', attempts: 1, error: { code: 'invalid_request', retryable: false } });
    const detail = await getBatch(client, batchId);
    expect(detail).toMatchObject({ status: 'completed', counts: { imagesReady: 2, videosReady: 1, jobsFailed: 1 } });
    expect(detail.items[0]).toMatchObject({ status: 'completed' });
    const items = await BatchItemModel.find({ batchId }).lean();
    expect(items[0]?.planSource).toBe('fallback');
  }, 60_000);
});

describe('errors that pause a lane', () => {
  it('pauses a lane until the next daily reset on a per-day quota, without burning attempts', async () => {
    const original = provider().plan.bind(provider());
    let exhausted = true;
    vi.spyOn(provider(), 'plan').mockImplementation(async (planRequest) =>
      exhausted ? { ok: false, error: classifyAiError(429, fixture('429-per-day-aistudio.json')) } : original(planRequest),
    );
    const batchId = await newBatch(2);
    await e2e.drive(async () => ((await JobModel.findOne({ batchId, type: 'plan' }).lean())?.deferrals ?? 0) >= 1, { timeoutMs: 30_000 });
    await e2e.settle();

    const reset = nextDailyReset(new Date(), 'UTC');
    const lane = defined(await LaneStateModel.findById(PLANNER_LANE).lean());
    expect(lane).toMatchObject({ reason: 'daily_quota' });
    expect(lane.pausedUntil?.getTime()).toBe(reset.getTime());
    expect(await JobModel.findOne({ batchId, type: 'plan' }).lean()).toMatchObject({ status: 'queued', attempts: 0, deferrals: 1, error: { code: 'daily_quota' } });
    expect(await paused()).toEqual([`${PLANNER_LANE}:daily_quota`]);
    expect((await getBatch(client, batchId)).delay).toEqual({ reason: 'daily_quota', resumesAt: reset.toISOString() });

    // The next day: the quota is back.
    exhausted = false;
    await LaneStateModel.deleteOne({ _id: PLANNER_LANE });
    await JobModel.updateMany({ batchId, status: 'queued' }, { $set: { runAt: new Date() } });
    expect((await e2e.driveBatch(batchId, { timeoutMs: 60_000 })).status).toBe('completed');
    await e2e.settle();
    expect(await JobModel.findOne({ batchId, type: 'plan' }).lean()).toMatchObject({ status: 'succeeded', attempts: 1, deferrals: 1 });
    expect((await getBatch(client, batchId)).delay).toBeNull();
  }, 90_000);

  it('pauses a lane for 15 minutes when billing is disabled and logs the raw body', async () => {
    const original = provider().generateImage.bind(provider());
    let disabled = true;
    vi.spyOn(provider(), 'generateImage').mockImplementation(async (imageRequest) =>
      disabled ? { ok: false, error: classifyAiError(403, fixture('403-billing-disabled.json')) } : original(imageRequest),
    );
    const batchId = await newBatch(3);
    await e2e.drive(async () => (await JobModel.countDocuments({ batchId, type: 'image', deferrals: { $gte: 1 } })) >= 1, { timeoutMs: 30_000 });
    await e2e.settle();

    const lane = defined(await LaneStateModel.findById(IMAGE_LANE).lean());
    expect(lane.reason).toBe('provider_unavailable');
    const pauseMs = (lane.pausedUntil?.getTime() ?? 0) - Date.now();
    expect(pauseMs).toBeGreaterThan(14 * 60_000);
    expect(pauseMs).toBeLessThanOrEqual(15 * 60_000);
    expect(lane.lastErrorBody).toContain('BILLING_DISABLED');
    expect(await paused()).toEqual([`${IMAGE_LANE}:provider_unavailable`]);

    const logged = e2e.logs.map((line) => JSON.parse(line) as { level: number; msg: string; lane?: string; rawBody?: string });
    const entry = logged.find((line) => line.msg.startsWith('lane paused: provider unavailable'));
    expect(entry).toMatchObject({ level: 50, lane: IMAGE_LANE });
    expect(entry?.rawBody).toContain('BILLING_DISABLED');
    // The other lanes of the batch are not held back: the video was submitted and is being generated meanwhile.
    expect(['awaiting_operation', 'succeeded']).toContain((await JobModel.findOne({ batchId, type: 'video' }).lean())?.status);
    expect((await getBatch(client, batchId)).delay?.reason).toBe('provider_unavailable');

    disabled = false;
    await LaneStateModel.deleteOne({ _id: IMAGE_LANE });
    await JobModel.updateMany({ batchId, status: 'queued' }, { $set: { runAt: new Date() } });
    expect((await e2e.driveBatch(batchId, { timeoutMs: 60_000 })).status).toBe('completed');
    await e2e.settle();
    const jobs = await JobModel.find({ batchId, type: 'image' }).lean();
    expect(jobs.every((job) => job.status === 'succeeded' && job.attempts === 1)).toBe(true);
    expect((await BatchModel.findById(batchId).lean())?.counts.imagesReady).toBe(2);
  }, 90_000);
});

describe('polling a video operation', () => {
  it('pauses the poll lane, not the submit lane, and does not resubmit the video', async () => {
    const original = provider().pollVideo.bind(provider());
    let limited = true;
    vi.spyOn(provider(), 'pollVideo').mockImplementation(async (pollRequest) =>
      limited ? { ok: false, error: classifyAiError(429, fixture('429-per-minute-retryinfo.json')) } : original(pollRequest),
    );
    const submit = vi.spyOn(provider(), 'submitVideo');
    const batchId = await newBatch(0);
    await e2e.drive(async () => ((await JobModel.findOne({ batchId, type: 'video' }).lean())?.deferrals ?? 0) >= 1, { timeoutMs: 30_000 });
    await e2e.settle();

    const poll = defined(await LaneStateModel.findById('fake:poll').lean());
    expect(poll.reason).toBe('rate_limited');
    expect((await LaneStateModel.findById('fake:veo-3.1-generate-001').lean())?.pausedUntil ?? null).toBeNull();
    expect(await paused()).toEqual(['fake:poll:rate_limited']);
    const video = defined(await JobModel.findOne({ batchId, type: 'video' }).lean());
    expect(video).toMatchObject({ status: 'awaiting_operation', attempts: 1, deferrals: 1 });
    expect(video.operation?.nextPollAt?.getTime()).toBe(poll.pausedUntil?.getTime());
    // A video that is only waiting for its poll reports the poll lane, and the images are not held back.
    expect((await getBatch(client, batchId)).delay).toEqual({ reason: 'rate_limited', resumesAt: defined(poll.pausedUntil).toISOString() });

    limited = false;
    await LaneStateModel.deleteOne({ _id: 'fake:poll' });
    await JobModel.updateOne({ _id: video._id }, { $set: { 'operation.nextPollAt': new Date() } });
    expect((await e2e.driveBatch(batchId, { timeoutMs: 60_000 })).status).toBe('completed');
    await e2e.settle();
    expect(submit).toHaveBeenCalledTimes(1);
    expect(await JobModel.findById(video._id).lean()).toMatchObject({ status: 'succeeded', attempts: 1, deferrals: 1 });
  }, 90_000);
});

describe('Shopify storage hiccups while outputs are saved', () => {
  it('retries the uploads and ends with exactly one file per output', async () => {
    const filesBefore = e2e.stub.shop(SHOP).files.size;
    e2e.stub.state.knobs.httpFailure = { operation: 'FileCreate', status: 500, remaining: 2 };
    const batchId = await newBatch(4);
    expect((await e2e.driveBatch(batchId, { timeoutMs: 60_000 })).status).toBe('completed');
    await e2e.settle();

    const jobs = await JobModel.find({ batchId }).lean();
    expect(jobs.every((job) => job.status === 'succeeded')).toBe(true);
    // Two failed uploads cost two extra attempts, wherever they landed.
    expect(jobs.reduce((total, job) => total + job.attempts, 0)).toBe(jobs.length + 2);
    expect(jobs.filter((job) => job.attempts > 1).every((job) => job.type !== 'plan')).toBe(true);
    expect(e2e.stub.shop(SHOP).files.size).toBe(filesBefore + 3);
    const detail = await getBatch(client, batchId);
    expect(detail.counts).toMatchObject({ jobsFailed: 0, imagesReady: 2, videosReady: 1 });
    expect(e2e.logs.filter((line) => line.includes('persisting an output failed')).length).toBe(2);
  }, 90_000);
});

describe('logs', () => {
  it('only report the lane pauses', () => {
    const expected = [
      'lane paused',
      'lane paused: provider unavailable or credentials rejected',
      'persisting an output failed',
      'released blocked jobs whose dependencies were already terminal',
    ];
    expect(e2e.problems(expected)).toEqual([]);
  });
});
