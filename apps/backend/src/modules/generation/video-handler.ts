import type { ClassifiedError, VideoSubmitRequest } from '../ai';
import { renderVideoPrompt } from '../ai';
import type { JobHandler, JobOutcome, QueueJob } from '../queue';
import { failure, outcomeFromAiError } from './outcomes';
import {
  beginJob,
  CANCELLED,
  downloadFailed,
  ensurePlan,
  loadImages,
  NO_PRODUCT_IMAGES,
  persistOutput,
  productImageSources,
  type Runtime,
} from './runtime';

// SPEC 10.4: up to 3 product images feed Veo's reference mode.
const MAX_REFERENCE_IMAGES = 3;

function awaiting(rt: Runtime, operationName: string, audit?: { promptVersion: string; renderedPrompt: string }): JobOutcome {
  const nextPollAt = new Date(rt.now().getTime() + rt.getConfig().queue.videoPollIntervalMs);
  return { kind: 'awaiting_operation', operation: { name: operationName, nextPollAt }, ...(audit === undefined ? {} : { audit }) };
}

// A poll that failed on the wire says nothing about the operation, which is already paid for: poll again.
// Every other transient error may be the operation's own failure, so the job is resubmitted.
function isTransportError(error: ClassifiedError): boolean {
  return error.kind === 'transient' && (error.providerReason === 'timeout' || error.providerReason === 'network_error');
}

async function runVideo(rt: Runtime, job: QueueJob, signal: AbortSignal): Promise<JobOutcome> {
  const run = await beginJob(rt, job, { references: false });
  if (run === null) return CANCELLED;
  const { ctx } = run;
  const outputIndex = job.outputIndex ?? 0;

  const plan = await ensurePlan(rt, run);
  const shot = plan.videoShots[outputIndex];
  if (shot === undefined) {
    return { kind: 'failed', error: failure('internal', `The creative plan has no video shot ${outputIndex + 1}`, false) };
  }
  const productSources = productImageSources(ctx.productSnapshot).slice(0, MAX_REFERENCE_IMAGES);
  if (productSources.length === 0) return NO_PRODUCT_IMAGES;

  const template = rt.getPrompt('video.user');
  const prompt = renderVideoPrompt(template.text, shot);
  const audit = { promptVersion: template.version, renderedPrompt: prompt };
  const video = ctx.config.video;

  try {
    const images = await loadImages(rt, productSources, signal);
    // The two Veo modes are mutually exclusive: reference images, or a first frame and no references.
    const inputs: Pick<VideoSubmitRequest, 'referenceImages' | 'startImage'> =
      video.mode === 'image_to_video'
        ? { referenceImages: [], startImage: images[0] }
        : { referenceImages: images.map((image) => ({ mimeType: image.mimeType, data: image.data })) };
    const submitted = await rt.ai.getProvider(ctx.config.provider).submitVideo({
      model: ctx.config.models.video,
      location: ctx.config.locations.video,
      signal,
      prompt,
      negativePrompt: video.negativePrompt,
      ...inputs,
      durationSeconds: video.durationSeconds,
      aspectRatio: video.aspectRatio,
      resolution: video.resolution,
      generateAudio: video.generateAudio,
      personGeneration: video.personGeneration,
      sampleCount: 1,
    });
    if (!submitted.ok) return outcomeFromAiError(submitted.error, audit);
    return awaiting(rt, submitted.value.operationName, audit);
  } catch (err) {
    const outcome = downloadFailed(err);
    if (outcome === null) throw err;
    return outcome;
  }
}

async function pollVideo(rt: Runtime, job: QueueJob, signal: AbortSignal): Promise<JobOutcome> {
  // A cancelled batch drops the operation without storing its result.
  const run = await beginJob(rt, job, { references: false });
  if (run === null) return CANCELLED;
  const { ctx } = run;
  if (job.operation === null) {
    return { kind: 'failed', error: failure('internal', 'The job is awaiting an operation but has none', false) };
  }
  const operationName = job.operation.name;

  const polled = await rt.ai.getProvider(ctx.config.provider).pollVideo({
    model: ctx.config.models.video,
    location: ctx.config.locations.video,
    signal,
    operationName,
  });
  if (!polled.ok) return isTransportError(polled.error) ? awaiting(rt, operationName) : outcomeFromAiError(polled.error);
  if (!polled.value.done) return awaiting(rt, operationName);

  // The operation finished, but the batch may have been cancelled meanwhile: do not store the result.
  if ((await beginJob(rt, job, { references: false })) === null) return CANCELLED;
  const plan = await ensurePlan(rt, run);
  const shot = plan.videoShots[job.outputIndex ?? 0];
  const stored = await persistOutput(rt, {
    job,
    ctx,
    kind: 'video',
    mimeType: polled.value.video.mimeType,
    bytes: polled.value.video.bytes,
    shotTitle: shot?.title ?? 'Video',
  });
  if (!stored.ok) return stored.outcome;
  return {
    kind: 'succeeded',
    output: { mediaAssetId: stored.media.id, providerResponseId: operationName, modelVersion: polled.value.modelVersion },
  };
}

export function createVideoHandler(rt: Runtime): JobHandler {
  return { type: 'video', run: (job, signal) => runVideo(rt, job, signal), poll: (job, signal) => pollVideo(rt, job, signal) };
}
