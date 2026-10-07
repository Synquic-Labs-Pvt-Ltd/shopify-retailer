import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { AiPart } from '../../src/modules/ai';
import { BatchItemModel } from '../../src/modules/batches/models';
import { JobModel } from '../../src/modules/queue/models';
import { MONGO_START_TIMEOUT_MS, startTestMongo, type TestMongo } from '../helpers/mongo';
import { createKit, prepareIndexes, SHOP_A, type Kit } from '../batches/kit';
import { failWith, invalidArgument, prepayDepleted } from '../batches/scripted-ai';

let mongo: TestMongo;
let kit: Kit;

beforeAll(async () => {
  mongo = await startTestMongo('rs_generation_handlers');
}, MONGO_START_TIMEOUT_MS);

afterAll(async () => {
  await mongo.stop();
});

beforeEach(async () => {
  await mongo.clear();
  kit = createKit();
  // Every download returns its own url as the body, so the order of inputs can be read back from the parts.
  kit.fetchRule.current = (url) => new Response(new TextEncoder().encode(url), { headers: { 'content-type': url.endsWith('.mp4') ? 'video/mp4' : 'image/jpeg' } });
  await prepareIndexes(kit);
});

const MB = 1024 * 1024;

// The inputs in a model request as readable lines: "text: ..." for labels and "inline: <url>" for bytes.
function describeParts(parts: AiPart[]): string[] {
  return parts.map((part) => {
    if (part.kind === 'text') return `text: ${part.text}`;
    if (part.kind === 'inlineData') return `inline: ${new TextDecoder().decode(part.data)}`;
    return `file: ${part.uri} (${part.mimeType})`;
  });
}

const labelsAndInputs = (parts: AiPart[]): string[] =>
  describeParts(parts).filter((line) => !line.startsWith('text: PRODUCT DATA') && !line.startsWith('text: Plan exactly'));

async function createWithRefs(own: string[], common: string[], productOverrides = {}) {
  const gid = kit.catalog.addProduct(productOverrides);
  const summary = await kit.create({ products: [{ productGid: gid, referenceMediaIds: own }], commonReferenceMediaIds: common });
  return { gid, batchId: summary.id };
}

const urlOf = (id: string): string => kit.media.assets.get(id)?.url ?? '';

describe('plan handler inputs (SPEC 10.2)', () => {
  it('sends product data, up to 3 product images, capped reference images and videos by url, own first', async () => {
    kit.config.current.ai.planner.maxReferenceImages = 2;
    kit.config.current.ai.planner.maxReferenceVideos = 2;
    const ownVideo = kit.reference(SHOP_A, 'video');
    const ownImage = kit.reference();
    const commonImage1 = kit.reference();
    const commonImage2 = kit.reference();
    const commonVideo1 = kit.reference(SHOP_A, 'video');
    const commonVideo2 = kit.reference(SHOP_A, 'video');
    const images = Array.from({ length: 5 }, (_unused, i) => `https://cdn.test/p/shoe-${i + 1}.jpg`);
    const { batchId } = await createWithRefs([ownVideo, ownImage], [commonImage1, commonImage2, commonVideo1, commonVideo2], {
      featuredImageUrl: images[0],
      imageUrls: images,
    });

    await kit.tick();
    const request = kit.ai.calls.plan[0];
    expect(request).toBeDefined();
    expect(request).toMatchObject({ model: 'fake-planner', location: 'us-central1', imageCount: 2, videoCount: 1, temperature: 0.6 });
    expect(request?.systemPrompt).toContain('exactly 2 still image shots and exactly 1 video shots');
    expect(request?.systemPrompt).toContain('8 seconds, 9:16');

    const lines = labelsAndInputs(request?.parts ?? []);
    expect(lines).toEqual([
      'text: PRODUCT IMAGE 1',
      `inline: ${images[0]}`,
      'text: PRODUCT IMAGE 2',
      `inline: ${images[1]}`,
      'text: PRODUCT IMAGE 3',
      `inline: ${images[2]}`,
      'text: STYLE REFERENCE IMAGE 1',
      `inline: ${urlOf(ownImage)}`,
      'text: STYLE REFERENCE IMAGE 2',
      `inline: ${urlOf(commonImage1)}`,
      'text: STYLE REFERENCE VIDEO 1',
      `file: ${urlOf(ownVideo)} (video/mp4)`,
      'text: STYLE REFERENCE VIDEO 2',
      `file: ${urlOf(commonVideo1)} (video/mp4)`,
    ]);
    expect(describeParts(request?.parts ?? [])[0]).toContain('"title"');
    // Videos go by url: their bytes are never downloaded for the planner.
    expect(kit.fetched.some((url) => url.endsWith('.mp4'))).toBe(false);

    const plan = await JobModel.findOne({ batchId, type: 'plan' }).lean();
    expect(plan?.promptVersion).toBe(kit.prompts.getPromptVersions().planner);
    expect(plan?.renderedPrompt).toContain('creative director');
  });

  it('retries once with inline bytes when the provider rejects the video url, skipping videos over 20 MB', async () => {
    kit.ai.hooks.plan = (request) => (request.parts.some((part) => part.kind === 'fileData') ? failWith(invalidArgument()) : undefined);
    const small = kit.media.addReference({ shopId: SHOP_A, mediaType: 'video', fileSize: 5 * MB, filename: 'small.mp4' });
    const big = kit.media.addReference({ shopId: SHOP_A, mediaType: 'video', fileSize: 30 * MB, filename: 'big.mp4' });
    const { batchId } = await createWithRefs([], [small, big]);

    await kit.tick();
    expect(kit.ai.calls.plan).toHaveLength(2);
    const retry = describeParts(kit.ai.calls.plan[1]?.parts ?? []);
    expect(retry.some((line) => line.startsWith('file:'))).toBe(false);
    expect(retry).toContain(`inline: ${urlOf(small)}`);
    expect(retry.join('\n')).not.toContain(urlOf(big));

    const item = await BatchItemModel.findOne({ batchId }).lean();
    expect(item?.planSource).toBe('planner');
    expect(item?.creativePlan?.warnings).toEqual([expect.stringContaining('big.mp4')]);
    expect(await JobModel.findOne({ batchId, type: 'plan' }).lean()).toMatchObject({ status: 'succeeded', attempts: 1 });
  });

  it('fails the plan job (and falls back) when the inline retry is rejected too, or when no video was involved', async () => {
    kit.ai.hooks.plan = () => failWith(invalidArgument());
    const video = kit.media.addReference({ shopId: SHOP_A, mediaType: 'video', fileSize: MB });
    const withVideo = await createWithRefs([], [video]);
    await kit.tick();
    expect(kit.ai.calls.plan).toHaveLength(2);
    expect(await JobModel.findOne({ batchId: withVideo.batchId, type: 'plan' }).lean()).toMatchObject({ status: 'failed', error: { code: 'invalid_request' } });

    const image = kit.reference();
    await createWithRefs([], [image]);
    kit.ai.calls.plan.length = 0;
    await kit.tick();
    expect(kit.ai.calls.plan).toHaveLength(1);
  });

  it('reads video inputs for the planner from the live caps while counts and models come from the snapshot', async () => {
    const ref = kit.reference();
    const { batchId } = await createWithRefs([], [ref]);
    kit.config.current.models = { planner: 'changed', image: 'changed', video: 'changed' };
    kit.config.current.outputs = { imagesPerProduct: 5, videosPerProduct: 2 };
    kit.config.current.ai.planner.temperature = 0.2;
    await kit.tick();
    expect(kit.ai.calls.plan[0]).toMatchObject({ model: 'fake-planner', imageCount: 2, videoCount: 1, temperature: 0.2 });
    expect((await JobModel.findOne({ batchId, type: 'plan' }).lean())?.lane).toBe('fake:fake-planner');
  });

  it('defers a planner 429 on the planner lane and keeps going afterwards', async () => {
    kit.ai.hooks.plan = (_request, call) => (call === 1 ? failWith(prepayDepleted()) : undefined);
    const ref = kit.reference();
    const { batchId } = await createWithRefs([], [ref]);
    await kit.tick();
    expect((await kit.governor.listPaused()).map((lane) => lane.lane)).toEqual(['fake:fake-planner']);
    expect(await JobModel.findOne({ batchId, type: 'plan' }).lean()).toMatchObject({ status: 'queued', attempts: 0, deferrals: 1 });
    kit.clock.advance(15 * 60_000);
    await kit.driveToTerminal(batchId);
    expect((await BatchItemModel.findOne({ batchId }).lean())?.planSource).toBe('planner');
  });
});

describe('image handler inputs (SPEC 10.3)', () => {
  it('labels product images then style references (own first, capped) and sends the snapshot parameters', async () => {
    kit.config.current.ai.image.maxStyleReferences = 3;
    const own1 = kit.reference();
    const own2 = kit.reference();
    const common1 = kit.reference();
    const common2 = kit.reference();
    const video = kit.reference(SHOP_A, 'video');
    const images = Array.from({ length: 5 }, (_unused, i) => `https://cdn.test/p/vase-${i + 1}.jpg`);
    const { batchId } = await createWithRefs([own1, video, own2], [common1, common2], { featuredImageUrl: images[0], imageUrls: images });

    // Edits to the generation settings after creation do not reach the batch.
    kit.config.current.image = { aspectRatio: '1:1', imageSize: '1K', outputMimeType: 'image/png' };
    kit.config.current.locations = { planner: 'global', image: 'global', video: 'global' };
    await kit.driveToTerminal(batchId);

    const request = kit.ai.calls.image[0];
    expect(request).toMatchObject({ model: 'fake-image', location: 'us-central1', aspectRatio: '3:4', imageSize: '2K', outputMimeType: 'image/jpeg' });
    const lines = describeParts(request?.parts ?? []);
    expect(lines.slice(0, 10)).toEqual([
      'text: PRODUCT IMAGE 1',
      `inline: ${images[0]}`,
      'text: PRODUCT IMAGE 2',
      `inline: ${images[1]}`,
      'text: PRODUCT IMAGE 3',
      `inline: ${images[2]}`,
      'text: STYLE REFERENCE 1',
      `inline: ${urlOf(own1)}`,
      'text: STYLE REFERENCE 2',
      `inline: ${urlOf(own2)}`,
    ]);
    expect(lines.slice(10, 12)).toEqual(['text: STYLE REFERENCE 3', `inline: ${urlOf(common1)}`]);
    expect(lines).toHaveLength(13);
    expect(lines[12]).toContain('Create one photorealistic lifestyle photograph');
    expect(lines[12]).toContain('3:4 aspect ratio');
    expect(lines.join('\n')).not.toContain(urlOf(common2));
  });

  it('works with videos only as references: product images plus the plan text', async () => {
    const video = kit.reference(SHOP_A, 'video');
    const { batchId } = await createWithRefs([], [video]);
    const done = await kit.driveToTerminal(batchId);
    expect(done.status).toBe('completed');
    const labels = describeParts(kit.ai.calls.image[0]?.parts ?? []).filter((line) => /^text: (PRODUCT IMAGE|STYLE REFERENCE) \d+$/.test(line));
    expect(labels).toEqual(['text: PRODUCT IMAGE 1', 'text: PRODUCT IMAGE 2']);
  });

  it('retries a failed download as transient, then completes', async () => {
    const ref = kit.reference();
    const { batchId } = await createWithRefs([], [ref]);
    let failures = 1;
    const normal = kit.fetchRule.current;
    kit.fetchRule.current = (url) => {
      if (url.includes('/p/') && failures > 0) {
        failures -= 1;
        return new Response('nope', { status: 500 });
      }
      return normal?.(url);
    };
    const done = await kit.driveToTerminal(batchId);
    expect(done.status).toBe('completed');
    const plan = await JobModel.findOne({ batchId, type: 'plan' }).lean();
    expect(plan?.attempts).toBe(2);
  });

  it('fails a job whose download keeps failing with the transient code', async () => {
    const ref = kit.reference();
    const { batchId } = await createWithRefs([], [ref]);
    kit.fetchRule.current = (url) => (url.includes('/p/') ? new Response('nope', { status: 404 }) : undefined);
    const done = await kit.driveToTerminal(batchId);
    expect(done.status).toBe('failed');
    expect(done.items[0]?.jobs.every((job) => job.status === 'failed' && job.errorCode === 'transient')).toBe(true);
    expect(kit.ai.calls.plan).toHaveLength(0);
    expect(kit.ai.calls.image).toHaveLength(0);
  });

  it('refuses a product without images before calling any provider', async () => {
    const ref = kit.reference();
    const { batchId } = await createWithRefs([], [ref], { featuredImageUrl: null, imageUrls: [] });
    const done = await kit.driveToTerminal(batchId);
    expect(done.status).toBe('failed');
    expect(done.items[0]?.jobs.map((job) => job.errorCode)).toEqual(['invalid_request', 'invalid_request', 'invalid_request', 'invalid_request']);
    expect(kit.ai.calls.plan.length + kit.ai.calls.image.length + kit.ai.calls.submit.length).toBe(0);
  });

  it('retries a storage failure as shopify_upload_failed and never stores an output twice', async () => {
    const ref = kit.reference();
    const { batchId } = await createWithRefs([], [ref]);
    kit.media.persistFailures.count = 1;
    await kit.tick(); // plan
    await kit.tick(); // images: one upload fails
    const waiting = await JobModel.findOne({ batchId, status: 'queued' }).lean();
    expect(waiting).toMatchObject({ type: 'image', attempts: 1, error: { code: 'shopify_upload_failed', retryable: true } });

    const done = await kit.driveToTerminal(batchId);
    expect(done.status).toBe('completed');
    expect(kit.media.persisted).toHaveLength(3);
    expect(await JobModel.findById(waiting?._id).lean()).toMatchObject({ status: 'succeeded', attempts: 2 });
  });
});

describe('video handler (SPEC 10.4)', () => {
  it('schedules the first poll with the live videoPollIntervalMs and releases the worker slot', async () => {
    const ref = kit.reference();
    const { batchId } = await createWithRefs([], [ref]);
    kit.config.current.queue.videoPollIntervalMs = 40_000;
    await kit.drive(async () => (await JobModel.countDocuments({ batchId, status: 'awaiting_operation' })) === 1);
    const video = await JobModel.findOne({ batchId, type: 'video' }).lean();
    expect(video?.operation?.nextPollAt?.getTime()).toBe(kit.clock.now().getTime() + 40_000);
    expect(video?.lease).toBeUndefined();
    expect(video?.promptVersion).toBe(kit.prompts.getPromptVersions().video);
  });

  it('keeps polling after a poll that failed on the wire, and resubmits after an operation failure', async () => {
    const ref = kit.reference();
    const { batchId } = await createWithRefs([], [ref]);
    kit.ai.hooks.poll = (_request, call) => {
      if (call === 1) return failWith({ ...invalidArgument(), kind: 'transient', retryable: true, providerReason: 'network_error' });
      if (call === 2) return failWith({ ...invalidArgument(), kind: 'transient', retryable: true, providerReason: null, httpStatus: 500 });
      return undefined;
    };
    const done = await kit.driveToTerminal(batchId);
    expect(done.status).toBe('completed');
    // The network blip re-polled the same operation; the 500 abandoned it and the job was submitted again.
    expect(kit.ai.calls.submit).toHaveLength(2);
    const [first, second, third] = kit.ai.calls.poll;
    expect(first?.operationName).toBe(second?.operationName);
    expect(third?.operationName).not.toBe(first?.operationName);
    expect(await JobModel.findOne({ batchId, type: 'video' }).lean()).toMatchObject({ status: 'succeeded', attempts: 2 });
  });
});
