import { Types } from 'mongoose';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { batchDetailSchema, type BatchDetail } from '@rs/shared';
import { AppError } from '../../src/core/errors';
import { BatchItemModel, BatchModel } from '../../src/modules/batches/models';
import { JobModel } from '../../src/modules/queue/models';
import { LaneStateModel } from '../../src/modules/ratelimit/models';
import { MONGO_START_TIMEOUT_MS, startTestMongo, type TestMongo } from '../helpers/mongo';
import { waitFor } from '../queue/kit';
import { createGate, createKit, prepareIndexes, SHOP_A, USER, type Kit } from './kit';
import { SAFE_IMAGE_NOTE, SAFE_VIDEO_NOTE } from '../../src/modules/ai/prompts';
import { dailyQuota, failWith, invalidArgument, overloaded, prepayDepleted, rateLimited, safetyBlocked } from './scripted-ai';

let mongo: TestMongo;
let kit: Kit;

beforeAll(async () => {
  mongo = await startTestMongo('rs_batches_flow');
}, MONGO_START_TIMEOUT_MS);

afterAll(async () => {
  await mongo.stop();
});

beforeEach(async () => {
  await mongo.clear();
  kit = createKit();
  await prepareIndexes(kit);
});

const actor = { shopId: SHOP_A, userId: USER };
const minutes = (n: number): number => n * 60_000;

async function rejection(promise: Promise<unknown>): Promise<AppError> {
  try {
    await promise;
  } catch (err) {
    if (err instanceof AppError) return err;
    throw err;
  }
  throw new Error('expected the call to be rejected');
}

// A batch of n products that all inherit one common reference.
async function batchOf(n: number): Promise<string> {
  const common = kit.reference();
  const summary = await kit.create({ products: kit.products(n).map((productGid) => ({ productGid })), commonReferenceMediaIds: [common] });
  return summary.id;
}

async function job(batchId: string, type: 'plan' | 'image' | 'video', index = 0) {
  const jobs = await kit.queue.store.listByBatch(SHOP_A, batchId);
  const found = jobs.find((candidate) => candidate.type === type && (type === 'plan' || candidate.outputIndex === index));
  if (found === undefined) throw new Error(`no ${type} job`);
  return found;
}

const jobsOf = (detail: BatchDetail, type: string) => detail.items.flatMap((item) => item.jobs.filter((j) => j.type === type));

describe('a full batch', () => {
  it('turns 3 products (one with own references plus common) into 2 images and 1 video each', async () => {
    const [p1, p2, p3] = kit.products(3) as [string, string, string];
    const own = kit.reference();
    const common = kit.reference();
    const summary = await kit.create({
      products: [{ productGid: p1, referenceMediaIds: [own] }, { productGid: p2 }, { productGid: p3 }],
      commonReferenceMediaIds: [common],
    });

    const detail = await kit.driveToTerminal(summary.id);
    batchDetailSchema.parse(detail);
    expect(detail.status).toBe('completed');
    expect(detail.counts).toMatchObject({ products: 3, jobsTotal: 12, jobsSucceeded: 12, jobsFailed: 0, jobsCancelled: 0, imagesReady: 6, videosReady: 3 });
    expect(detail.finishedAt).not.toBeNull();
    expect(detail.delay).toBeNull();
    expect(detail.items.map((item) => item.referenceMode)).toEqual(['own_plus_common', 'common_only', 'common_only']);
    expect(detail.items.map((item) => item.title)).toEqual(['Lamp 1001', 'Lamp 1002', 'Lamp 1003']);

    for (const item of detail.items) {
      expect(item.status).toBe('completed');
      expect(item.outputs.map((output) => output.mediaType)).toEqual(['image', 'image', 'video']);
      expect(item.outputs.every((output) => output.role === 'output' && output.status === 'ready')).toBe(true);
      expect(item.jobs.map((j) => `${j.type}:${j.outputIndex}:${j.status}`)).toEqual([
        'plan:null:succeeded',
        'image:0:succeeded',
        'image:1:succeeded',
        'video:0:succeeded',
      ]);
      expect(item.jobs.every((j) => j.errorCode === null)).toBe(true);
    }

    const stored = await BatchItemModel.find({ batchId: summary.id }).lean();
    expect(stored.every((item) => item.planSource === 'planner' && item.creativePlan?.imageShots.length === 2)).toBe(true);
    expect(stored.every((item) => item.finishedAt instanceof Date && item.counts.succeeded === 4 && item.counts.jobsTotal === 4)).toBe(true);

    const short = summary.id.slice(-6);
    const names = kit.media.persisted.map((input) => input.filename).sort();
    expect(names).toHaveLength(9);
    expect(names).toContain(`rs-lamp-1001-${short}-img1.jpg`);
    expect(names).toContain(`rs-lamp-1001-${short}-img2.jpg`);
    expect(names).toContain(`rs-lamp-1003-${short}-vid1.mp4`);
    const image = kit.media.persisted.find((input) => input.mediaType === 'image');
    expect(image).toMatchObject({ alt: expect.stringMatching(/^Lamp 100\d: Fake image shot [12]$/), mimeType: 'image/jpeg' });

    const imageJob = await JobModel.findOne({ batchId: summary.id, type: 'image' }).lean();
    expect(imageJob?.promptVersion).toBe(kit.prompts.getPromptVersions().image);
    expect(imageJob?.renderedPrompt).toContain('A calm, premium lifestyle scene');
    expect(imageJob?.output?.modelVersion).toBe('fake-image');
    expect(await BatchModel.countDocuments({ status: 'completed' })).toBe(1);
  });

  it('reports each batch status transition: queued, running, completed', async () => {
    const batchId = await batchOf(1);
    expect((await kit.detail(batchId)).status).toBe('queued');
    expect((await kit.detail(batchId)).items[0]?.status).toBe('pending');
    await kit.tick(); // plan job
    const afterPlan = await kit.detail(batchId);
    expect(afterPlan.status).toBe('running');
    expect(afterPlan.items[0]?.status).toBe('generating');
    expect((await BatchModel.findById(batchId).lean())?.startedAt).toBeInstanceOf(Date);
    const done = await kit.driveToTerminal(batchId);
    expect(done.status).toBe('completed');
  });
});

describe('provider throttling and outages', () => {
  it('defers on a 429 without burning attempts, shows a delay, and completes after the pause', async () => {
    kit.ai.hooks.image = (_request, call) => (call <= 2 ? failWith(rateLimited()) : undefined);
    const batchId = await batchOf(1);

    await kit.drive(async () => (await kit.detail(batchId)).delay !== null);
    const paused = await kit.detail(batchId);
    expect(paused.status).toBe('running');
    expect(paused.delay?.reason).toBe('rate_limited');
    const resumesAt = new Date(paused.delay?.resumesAt ?? 0).getTime();
    expect(resumesAt).toBeGreaterThanOrEqual(kit.clock.now().getTime() + 12_000);

    const deferred = await JobModel.find({ batchId, type: 'image' }).lean();
    expect(deferred.map((j) => [j.status, j.attempts, j.deferrals])).toEqual([
      ['queued', 0, 1],
      ['queued', 0, 1],
    ]);
    expect(deferred.every((j) => j.runAt.getTime() === resumesAt)).toBe(true);
    expect(paused.items[0]?.jobs.filter((j) => j.type === 'image').every((j) => j.status === 'queued' && j.errorCode === null)).toBe(true);

    kit.clock.advance(resumesAt - kit.clock.now().getTime());
    const done = await kit.driveToTerminal(batchId);
    expect(done.status).toBe('completed');
    expect(done.delay).toBeNull();
    const images = await JobModel.find({ batchId, type: 'image' }).lean();
    expect(images.every((j) => j.status === 'succeeded' && j.attempts === 1)).toBe(true);
    expect(images.reduce((sum, j) => sum + j.deferrals, 0)).toBeGreaterThanOrEqual(2);
  });

  it('pauses the lane for 15 minutes on a prepaid-credits style error and defers every job in it', async () => {
    let blocked = true;
    kit.ai.hooks.image = () => (blocked ? failWith(prepayDepleted()) : undefined);
    const batchId = await batchOf(2);

    await kit.drive(async () => (await kit.detail(batchId)).delay !== null);
    const detail = await kit.detail(batchId);
    expect(detail.delay).toEqual({ reason: 'provider_unavailable', resumesAt: new Date(kit.clock.now().getTime() + minutes(15)).toISOString() });
    expect((await LaneStateModel.findById('fake:fake-image').lean())?.reason).toBe('provider_unavailable');
    expect((await kit.governor.listPaused()).map((lane) => lane.lane)).toEqual(['fake:fake-image']);

    // Plans and videos live on other lanes and keep going while the image lane waits.
    await kit.drive(async () => (await kit.detail(batchId)).counts.videosReady === 2, { stepMs: 5000 });
    expect((await kit.detail(batchId)).status).toBe('running');
    const stuck = await JobModel.find({ batchId, type: 'image' }).lean();
    expect(stuck.every((j) => j.status === 'queued' && j.attempts === 0)).toBe(true);

    blocked = false;
    kit.clock.advance(minutes(15));
    const done = await kit.driveToTerminal(batchId);
    expect(done.status).toBe('completed');
    expect(done.counts.imagesReady).toBe(4);
  });

  it('waits until the next daily reset on a daily quota error', async () => {
    kit.ai.hooks.image = (_request, call) => (call === 1 ? failWith(dailyQuota()) : undefined);
    const batchId = await batchOf(1);
    await kit.drive(async () => (await kit.detail(batchId)).delay !== null);
    const detail = await kit.detail(batchId);
    expect(detail.delay).toEqual({ reason: 'daily_quota', resumesAt: '2026-10-08T00:00:00.000Z' });
    // Let the video on its own lane finish first: a half-day jump would time out an operation in flight.
    await kit.drive(async () => (await kit.detail(batchId)).counts.videosReady === 1, { stepMs: 5000 });
    kit.clock.set('2026-10-08T00:00:00.000Z');
    expect((await kit.driveToTerminal(batchId)).status).toBe('completed');
  });

  it('retries a transient provider error with backoff and consumes an attempt', async () => {
    kit.ai.hooks.image = (_request, call) => (call === 1 ? failWith(overloaded()) : undefined);
    const batchId = await batchOf(1);
    const done = await kit.driveToTerminal(batchId);
    expect(done.status).toBe('completed');
    const images = await JobModel.find({ batchId, type: 'image' }).lean();
    expect(images.map((j) => j.attempts).sort()).toEqual([1, 2]);
    expect(done.delay).toBeNull();
  });

  it('shows the poll lane pause as the delay while a video is awaiting its operation', async () => {
    kit.ai.hooks.poll = (_request, call) => (call === 1 ? failWith(rateLimited()) : undefined);
    const batchId = await batchOf(1);
    await kit.drive(async () => (await kit.detail(batchId)).delay !== null, { stepMs: 5000 });
    expect((await kit.detail(batchId)).delay?.reason).toBe('rate_limited');
    expect((await kit.governor.listPaused()).map((lane) => lane.lane)).toEqual(['fake:poll']);
    const done = await kit.driveToTerminal(batchId);
    expect(done.status).toBe('completed');
  });
});

describe('planner failures never block outputs', () => {
  it('falls back to the deterministic plan when the planner request is rejected', async () => {
    kit.ai.hooks.plan = () => failWith(invalidArgument());
    const batchId = await batchOf(1);
    const done = await kit.driveToTerminal(batchId);

    expect(done.status).toBe('completed');
    expect(done.counts).toMatchObject({ jobsFailed: 1, jobsSucceeded: 3, imagesReady: 2, videosReady: 1 });
    expect(done.items[0]?.status).toBe('completed');
    expect(done.items[0]?.jobs[0]).toEqual({ type: 'plan', outputIndex: null, status: 'failed', errorCode: 'invalid_request' });
    const item = await BatchItemModel.findOne({ batchId }).lean();
    expect(item?.planSource).toBe('fallback');
    expect(item?.creativePlan?.imageShots.map((shot) => shot.shotId)).toEqual(['fallback-image-1', 'fallback-image-2']);
    expect(kit.ai.calls.plan).toHaveLength(1);
    const imageJob = await JobModel.findOne({ batchId, type: 'image' }).lean();
    expect(imageJob?.renderedPrompt).toContain('displayed as the hero');
  });

  it('retries an invalid plan once, then falls back', async () => {
    kit.ai.hooks.plan = () => ({ ok: true, value: { json: { not: 'a plan' }, rawText: '{}', responseId: null, modelVersion: null } });
    const batchId = await batchOf(1);
    const done = await kit.driveToTerminal(batchId);
    expect(done.status).toBe('completed');
    expect(kit.ai.calls.plan).toHaveLength(2);
    expect((await BatchItemModel.findOne({ batchId }).lean())?.planSource).toBe('fallback');
    const plan = await job(batchId, 'plan');
    expect(plan).toMatchObject({ status: 'failed', error: { code: 'no_output', retryable: false } });
  });

  it('keeps a plan that arrived first: the fallback never overwrites it', async () => {
    const batchId = await batchOf(1);
    await kit.tick();
    const before = await BatchItemModel.findOne({ batchId }).lean();
    expect(before?.planSource).toBe('planner');
    const ctx = await kit.batches.service.getItemContext(SHOP_A, String(before?._id));
    const stored = await kit.batches.service.setCreativePlan(SHOP_A, ctx.itemId, { ...(ctx.creativePlan as NonNullable<typeof ctx.creativePlan>), warnings: ['late'] }, 'fallback');
    expect(stored.source).toBe('planner');
    expect(stored.plan.warnings).toEqual([]);
  });
});

describe('failed outputs', () => {
  it('retries a safety-blocked image once with the safer presentation (no person, no style references) and keeps the batch complete', async () => {
    kit.ai.hooks.image = (_request, call) => (call === 1 ? failWith(safetyBlocked()) : undefined);
    const batchId = await batchOf(1);
    const done = await kit.driveToTerminal(batchId);

    expect(done.status).toBe('completed');
    expect(done.counts).toMatchObject({ jobsFailed: 0, jobsSucceeded: 4, imagesReady: 2, videosReady: 1 });
    expect(kit.ai.calls.image).toHaveLength(3);
    const text = (index: number): string =>
      (kit.ai.calls.image[index]?.parts ?? []).flatMap((part) => (part.kind === 'text' ? [part.text] : [])).join('\n');
    const retry = kit.ai.calls.image.map((_call, index) => text(index)).filter((prompt) => prompt.includes(SAFE_IMAGE_NOTE));
    expect(retry).toHaveLength(1);
    expect(retry[0]).not.toMatch(/STYLE REFERENCE \d/);
    expect(retry[0]).toContain('PRODUCT IMAGE 1');
    const retried = await JobModel.findOne({ batchId, type: 'image', attempts: 2 }).lean();
    expect(retried?.renderedPrompt).toContain(SAFE_IMAGE_NOTE);
  });

  it('fails an image that is blocked twice for good: the item is partial and the batch completed_with_errors', async () => {
    // Calls 1 and 3 are the same shot, blocked once as planned and once in the safer presentation.
    kit.ai.hooks.image = (_request, call) => (call === 1 || call === 3 ? failWith(safetyBlocked()) : undefined);
    const batchId = await batchOf(1);
    const done = await kit.driveToTerminal(batchId);

    expect(done.status).toBe('completed_with_errors');
    expect(done.counts).toMatchObject({ jobsFailed: 1, jobsSucceeded: 3, imagesReady: 1, videosReady: 1 });
    expect(done.items[0]?.status).toBe('partial');
    expect(done.items[0]?.outputs).toHaveLength(2);
    const failed = done.items[0]?.jobs.filter((j) => j.status === 'failed');
    expect(failed).toEqual([{ type: 'image', outputIndex: expect.any(Number), status: 'failed', errorCode: 'safety_blocked' }]);
    expect(kit.ai.calls.image).toHaveLength(3);
    const failedJob = await JobModel.findOne({ batchId, status: 'failed' }).lean();
    expect(failedJob).toMatchObject({ attempts: 2, error: { code: 'safety_blocked', retryable: false } });
    expect(failedJob?.renderedPrompt).toContain(SAFE_IMAGE_NOTE);
  });

  it('fails a batch with no outputs as failed', async () => {
    kit.ai.hooks.plan = () => failWith(invalidArgument());
    kit.ai.hooks.image = () => failWith(safetyBlocked());
    kit.ai.hooks.submit = () => failWith(safetyBlocked());
    const batchId = await batchOf(2);
    const done = await kit.driveToTerminal(batchId);
    expect(done.status).toBe('failed');
    expect(done.items.map((item) => item.status)).toEqual(['failed', 'failed']);
    expect(done.counts).toMatchObject({ jobsSucceeded: 0, jobsFailed: 8, imagesReady: 0, videosReady: 0 });
  });

  it('retry-failed brings a completed_with_errors batch to completed', async () => {
    kit.ai.hooks.image = (_request, call) => (call === 1 || call === 3 ? failWith(safetyBlocked()) : undefined);
    const batchId = await batchOf(1);
    await kit.driveToTerminal(batchId);
    kit.ai.hooks.image = undefined;

    const retried = await kit.batches.service.retryFailed(actor, batchId);
    expect(retried.status).toBe('running');
    expect(retried.counts).toMatchObject({ jobsFailed: 0, jobsSucceeded: 3 });
    expect(retried.finishedAt).toBeNull();
    const requeued = await JobModel.findOne({ batchId, status: 'queued' }).lean();
    expect(requeued).toMatchObject({ attempts: 0, type: 'image' });
    expect((await kit.detail(batchId)).items[0]?.status).toBe('generating');

    const done = await kit.driveToTerminal(batchId);
    expect(done.status).toBe('completed');
    expect(done.counts).toMatchObject({ jobsFailed: 0, jobsSucceeded: 4, imagesReady: 2, videosReady: 1 });
    expect(done.items[0]?.status).toBe('completed');
    expect(done.items[0]?.outputs).toHaveLength(3);
    expect(done.finishedAt).not.toBeNull();
  });

  it('retry-failed also re-runs a failed plan job without replacing the fallback plan', async () => {
    kit.ai.hooks.plan = () => failWith(invalidArgument());
    const batchId = await batchOf(1);
    await kit.driveToTerminal(batchId);
    kit.ai.hooks.plan = undefined;
    await kit.batches.service.retryFailed(actor, batchId);
    const done = await kit.driveToTerminal(batchId);
    expect(done.status).toBe('completed');
    expect(done.counts.jobsFailed).toBe(0);
    expect((await BatchItemModel.findOne({ batchId }).lean())?.planSource).toBe('fallback');
    expect(kit.ai.calls.plan).toHaveLength(1);
  });

  it('refuses retry-failed for a running batch, a cancelled batch and an inactive shop', async () => {
    const batchId = await batchOf(1);
    expect((await rejection(kit.batches.service.retryFailed(actor, batchId))).code).toBe('validation_failed');
    await kit.batches.service.cancel(actor, batchId);
    expect((await kit.detail(batchId)).status).toBe('cancelled');
    expect((await rejection(kit.batches.service.retryFailed(actor, batchId))).code).toBe('validation_failed');
    kit.shopStatus.set(SHOP_A, 'reauth_required');
    expect((await rejection(kit.batches.service.retryFailed(actor, batchId))).code).toBe('shop_reauth_required');
    expect((await kit.api().post(`/batches/${batchId}/retry-failed`)).status).toBe(409);
  });
});

describe('cancel', () => {
  it('cancels every queued and blocked job of a batch that has not started', async () => {
    const batchId = await batchOf(2);
    const summary = await kit.batches.service.cancel(actor, batchId);
    expect(summary.status).toBe('cancelled');
    expect(summary.counts).toMatchObject({ jobsCancelled: 8, jobsSucceeded: 0 });
    expect(summary.finishedAt).not.toBeNull();
    const detail = await kit.detail(batchId);
    expect(detail.items.map((item) => item.status)).toEqual(['cancelled', 'cancelled']);
    expect(jobsOf(detail, 'image').every((j) => j.status === 'cancelled' && j.errorCode === 'cancelled')).toBe(true);
    await kit.tick();
    expect(kit.ai.calls.plan).toHaveLength(0);
    // A second cancel is a no-op.
    expect((await kit.batches.service.cancel(actor, batchId)).status).toBe('cancelled');
  });

  it('cancels jobs awaiting an operation and keeps the images that finished', async () => {
    const batchId = await batchOf(2);
    await kit.drive(async () => (await kit.detail(batchId)).counts.imagesReady === 4 && (await JobModel.countDocuments({ batchId, status: 'awaiting_operation' })) === 2);

    const summary = await kit.batches.service.cancel(actor, batchId);
    expect(summary.status).toBe('cancelled');
    expect(summary.counts).toMatchObject({ jobsCancelled: 2, imagesReady: 4, videosReady: 0 });
    const detail = await kit.detail(batchId);
    expect(detail.items.map((item) => item.status)).toEqual(['cancelled', 'cancelled']);
    expect(detail.items.every((item) => item.outputs.length === 2)).toBe(true);
    expect(jobsOf(detail, 'video').every((j) => j.status === 'cancelled')).toBe(true);

    const pollsBefore = kit.ai.calls.poll.length;
    kit.clock.advance(60_000);
    await kit.tick();
    expect(kit.ai.calls.poll).toHaveLength(pollsBefore);
  });

  it('lets running jobs finish and keep their output, then ends the batch as cancelled', async () => {
    const gate = createGate();
    kit.ai.hooks.image = async () => {
      await gate.hold();
      return undefined;
    };
    const batchId = await batchOf(1);
    await kit.tick(); // plan
    await kit.queue.runner.tickOnce(); // 2 images (held) and 1 video submit
    await waitFor(() => gate.waiting === 2);
    await waitFor(async () => (await JobModel.countDocuments({ batchId, status: 'awaiting_operation' })) === 1);

    const during = await kit.batches.service.cancel(actor, batchId);
    expect(during.status).toBe('running'); // the two running image jobs have not finished yet
    expect(during.counts.jobsCancelled).toBe(1);

    gate.open();
    await kit.queue.runner.idle();
    const done = await kit.detail(batchId);
    expect(done.status).toBe('cancelled');
    expect(done.counts).toMatchObject({ imagesReady: 2, videosReady: 0, jobsCancelled: 1, jobsSucceeded: 3 });
    expect(done.items[0]?.outputs.map((output) => output.mediaType)).toEqual(['image', 'image']);
  });

  it('does not start new provider work for a job that was running when its batch was cancelled', async () => {
    let failOnce = true;
    const gate = createGate();
    kit.ai.hooks.image = async () => {
      await gate.hold();
      if (failOnce) {
        failOnce = false;
        return failWith(overloaded());
      }
      return undefined;
    };
    const batchId = await batchOf(1);
    await kit.tick();
    await kit.queue.runner.tickOnce();
    await waitFor(() => gate.waiting === 2);
    await kit.batches.service.cancel(actor, batchId);
    gate.open();
    await kit.queue.runner.idle();

    // One image job failed transiently after the cancel and was requeued; it must not run again.
    kit.clock.advance(minutes(10));
    await kit.drive(async () => (await kit.detail(batchId)).status === 'cancelled');
    const detail = await kit.detail(batchId);
    expect(detail.status).toBe('cancelled');
    expect(kit.ai.calls.image).toHaveLength(2);
    expect(detail.counts.imagesReady).toBe(1);
  });

  it('cancelAllForShop ends every active batch of the shop (uninstall)', async () => {
    const a = await batchOf(1);
    const b = await batchOf(1);
    expect(await kit.batches.service.cancelAllForShop(SHOP_A)).toBe(2);
    expect((await kit.detail(a)).status).toBe('cancelled');
    expect((await kit.detail(b)).status).toBe('cancelled');
    expect(await JobModel.countDocuments({ shopId: SHOP_A, status: { $nin: ['cancelled'] } })).toBe(0);
  });
});

describe('video modes', () => {
  it('sends up to 3 product images as reference images in the default mode', async () => {
    const images = Array.from({ length: 5 }, (_unused, i) => `https://cdn.test/p/big-${i + 1}.jpg`);
    const gid = kit.catalog.addProduct({ featuredImageUrl: images[0] ?? null, imageUrls: images });
    const common = kit.reference();
    const summary = await kit.create({ products: [{ productGid: gid }], commonReferenceMediaIds: [common] });
    expect((await kit.driveToTerminal(summary.id)).status).toBe('completed');

    const submit = kit.ai.calls.submit[0];
    expect(submit?.startImage).toBeUndefined();
    expect(submit?.referenceImages).toHaveLength(3);
    expect(submit).toMatchObject({ model: 'fake-video', durationSeconds: 8, aspectRatio: '9:16', resolution: '720p', sampleCount: 1, generateAudio: false });
    expect(submit?.negativePrompt).toContain('watermark');
  });

  it('uses the first product image as the start frame, with no references, when the snapshot says image_to_video', async () => {
    kit.config.current.video = { ...kit.config.current.video, mode: 'image_to_video', durationSeconds: 6 };
    const batchId = await batchOf(1);
    // The mode is frozen in the batch: flipping the live config afterwards changes nothing for it.
    kit.config.current.video = { ...kit.config.current.video, mode: 'reference_images', durationSeconds: 8 };
    const done = await kit.driveToTerminal(batchId);
    expect(done.status).toBe('completed');

    const submit = kit.ai.calls.submit[0];
    expect(submit?.referenceImages).toEqual([]);
    expect(submit?.startImage?.mimeType).toBe('image/jpeg');
    expect(submit?.durationSeconds).toBe(6);
    expect(kit.fetched.filter((url) => url.includes('/p/1001-')).length).toBeGreaterThan(0);
  });
});

describe('video polling', () => {
  it('polls until the second poll completes and stores the video', async () => {
    const batchId = await batchOf(1);
    await kit.drive(async () => (await JobModel.countDocuments({ batchId, status: 'awaiting_operation' })) === 1);
    const awaiting = await job(batchId, 'video');
    expect(awaiting.operation?.name).toMatch(/^fake\/operations\//);
    expect(awaiting.operation?.nextPollAt.getTime()).toBe(kit.clock.now().getTime() + 15_000);
    expect(awaiting.renderedPrompt).toContain('slow push-in');

    const done = await kit.driveToTerminal(batchId);
    expect(done.status).toBe('completed');
    expect(kit.ai.calls.poll).toHaveLength(2);
    const video = await job(batchId, 'video');
    expect(video).toMatchObject({ status: 'succeeded', output: { providerResponseId: awaiting.operation?.name, modelVersion: 'fake-video' } });
    expect(kit.media.persisted.filter((input) => input.mediaType === 'video').map((input) => input.mimeType)).toEqual(['video/mp4']);
  });

  it('resubmits a video the provider filtered once, as a person-free orbit, and then succeeds', async () => {
    kit.ai.hooks.poll = (_request, call) => (call === 1 ? failWith(safetyBlocked()) : undefined);
    const batchId = await batchOf(1);
    const done = await kit.driveToTerminal(batchId);

    expect(done.status).toBe('completed');
    expect(kit.ai.calls.submit).toHaveLength(2);
    expect(kit.ai.calls.submit[0]?.prompt).not.toContain(SAFE_VIDEO_NOTE);
    expect(kit.ai.calls.submit[1]?.prompt).toContain(SAFE_VIDEO_NOTE);
    expect(kit.ai.calls.submit[1]?.prompt).toContain('Camera: slow orbit around the product');
    expect(await JobModel.findOne({ batchId, type: 'video' }).lean()).toMatchObject({ status: 'succeeded' });
  });

  it('fails the video as safety_blocked when the finished operation was filtered again in the safer presentation', async () => {
    kit.ai.hooks.poll = () => failWith(safetyBlocked());
    const batchId = await batchOf(1);
    const done = await kit.driveToTerminal(batchId);
    expect(done.status).toBe('completed_with_errors');
    expect(done.items[0]?.jobs.find((j) => j.type === 'video')).toMatchObject({ status: 'failed', errorCode: 'safety_blocked' });
    expect(done.items[0]?.status).toBe('partial');
    expect(kit.ai.calls.submit).toHaveLength(2);
  });

  it('ignores an operation that finishes after the batch was cancelled', async () => {
    const gate = createGate();
    kit.ai.hooks.poll = async () => {
      await gate.hold();
      return undefined;
    };
    const batchId = await batchOf(1);
    // Second poll is the one that would complete: hold the first poll, release it, then hold the next.
    await kit.drive(async () => (await JobModel.countDocuments({ batchId, status: 'awaiting_operation' })) === 1 && (await kit.detail(batchId)).counts.imagesReady === 2);
    kit.clock.advance(15_000);
    await kit.queue.runner.tickOnce();
    await waitFor(() => gate.waiting === 1);

    await kit.batches.service.cancel(actor, batchId);
    gate.open();
    await kit.queue.runner.idle();

    const video = await job(batchId, 'video');
    expect(video.status).toBe('cancelled');
    expect(video.output).toBeNull();
    expect(kit.media.persisted.filter((input) => input.mediaType === 'video')).toHaveLength(0);
    const detail = await kit.detail(batchId);
    expect(detail.counts.videosReady).toBe(0);
    expect(detail.items[0]?.outputs.map((output) => output.mediaType)).toEqual(['image', 'image']);
  });
});

describe('aggregation under repeated and concurrent reports', () => {
  it('counts a job reported twice once', async () => {
    const batchId = await batchOf(2);
    const before = await kit.driveToTerminal(batchId);
    const reportedBefore = kit.reported.length;
    expect(reportedBefore).toBe(8);

    await Promise.all(kit.reported.flatMap((jobReport) => [kit.batches.service.reportJobFinished(jobReport), kit.batches.service.reportJobFinished(jobReport)]));
    const after = await kit.detail(batchId);
    expect(after.counts).toEqual(before.counts);
    expect(after.status).toBe('completed');
    expect(after.items.map((item) => item.outputs.length)).toEqual([3, 3]);
    expect(after.finishedAt).toBe(before.finishedAt);
  });

  it('ends with the true counts when reports race with job completions', async () => {
    const batchId = await batchOf(1);
    const jobs = await kit.queue.store.listByBatch(SHOP_A, batchId);
    const [plan, image0, image1, video] = jobs as [(typeof jobs)[number], (typeof jobs)[number], (typeof jobs)[number], (typeof jobs)[number]];
    const states: [typeof plan, 'succeeded' | 'failed', string | null][] = [
      [plan, 'succeeded', null],
      [image0, 'succeeded', '0'.repeat(23) + '1'],
      [image1, 'succeeded', '0'.repeat(23) + '2'],
      [video, 'failed', null],
    ];

    const reports: Promise<void>[] = [];
    for (const [target, status, mediaId] of states) {
      await JobModel.updateOne(
        { _id: target.id },
        { $set: { status, finishedAt: new Date(), ...(mediaId === null ? {} : { 'output.mediaAssetId': mediaId }) }, $unset: { lease: 1 } },
      );
      for (let i = 0; i < 5; i += 1) reports.push(kit.batches.service.reportJobFinished(target));
    }
    await Promise.all(reports);

    const batch = await BatchModel.findById(batchId).lean();
    expect(batch).toMatchObject({ status: 'completed_with_errors', counts: { jobsSucceeded: 3, jobsFailed: 1, jobsCancelled: 0, imagesReady: 2, videosReady: 0 } });
    const item = await BatchItemModel.findOne({ batchId }).lean();
    expect(item).toMatchObject({ status: 'partial', counts: { succeeded: 3, failed: 1, cancelled: 0 } });
    expect(item?.outputMediaIds.map(String)).toEqual(['0'.repeat(23) + '1', '0'.repeat(23) + '2']);
    expect(batch?.statsApplied).toBeLessThanOrEqual(batch?.statsSeq ?? 0);
  });

  it('keeps consistent counters for a larger batch whose jobs finish concurrently', async () => {
    const batchId = await batchOf(10);
    const done = await kit.driveToTerminal(batchId);
    expect(done.status).toBe('completed');
    expect(done.counts).toMatchObject({ jobsTotal: 40, jobsSucceeded: 40, imagesReady: 20, videosReady: 10 });
    expect(done.items).toHaveLength(10);
    expect(done.items.every((item) => item.status === 'completed' && item.outputs.length === 3)).toBe(true);
    const batch = await BatchModel.findById(batchId).lean();
    expect(batch?.statsApplied).toBeLessThanOrEqual(batch?.statsSeq ?? 0);
    expect(batch?.statsSeq).toBeGreaterThanOrEqual(40);
  });

  it('repairs the counters on read when a completion report was lost', async () => {
    const batchId = await batchOf(2);
    await kit.driveToTerminal(batchId);
    await BatchModel.updateOne(
      { _id: batchId },
      { $set: { status: 'running', 'counts.jobsSucceeded': 5, 'counts.imagesReady': 1, 'counts.videosReady': 0 }, $unset: { finishedAt: 1 } },
    );
    await BatchItemModel.updateMany({ batchId }, { $set: { status: 'generating', 'counts.succeeded': 1, outputMediaIds: [] }, $unset: { finishedAt: 1 } });

    const detail = await kit.detail(batchId);
    expect(detail.status).toBe('completed');
    expect(detail.counts).toMatchObject({ jobsSucceeded: 8, imagesReady: 4, videosReady: 2 });
    expect(detail.finishedAt).not.toBeNull();
    expect(detail.items.every((item) => item.status === 'completed' && item.outputs.length === 3)).toBe(true);
    expect((await BatchModel.findById(batchId).lean())?.status).toBe('completed');
  });

  it('does not finish a batch while some of its jobs are still being created', async () => {
    const batchId = await batchOf(1);
    await JobModel.deleteMany({ batchId, type: { $in: ['image', 'video'] } });
    await JobModel.updateOne({ batchId, type: 'plan' }, { $set: { status: 'succeeded' } });
    const plan = await job(batchId, 'plan');
    await kit.batches.service.reportJobFinished(plan);
    expect((await BatchModel.findById(batchId).lean())?.status).toBe('queued');
  });
});

describe('tenant isolation of the handler-facing methods', () => {
  it('does not give another shop the item context', async () => {
    const batchId = await batchOf(1);
    const item = await BatchItemModel.findOne({ batchId }).lean();
    const other = new Types.ObjectId().toHexString();
    expect((await rejection(kit.batches.service.getItemContext(other, String(item?._id)))).code).toBe('not_found');
    const ctx = await kit.batches.service.getItemContext(SHOP_A, String(item?._id));
    expect(ctx.references).toHaveLength(1);
    expect(ctx.config.outputs).toEqual({ imagesPerProduct: 2, videosPerProduct: 1 });
    expect(ctx.cancelRequested).toBe(false);
  });
});
