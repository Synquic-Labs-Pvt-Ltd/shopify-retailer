import { buildImageParts, renderImagePrompt } from '../ai';
import type { JobHandler, JobOutcome, QueueJob } from '../queue';
import { failure, isSafeAttempt, outcomeFromGenerationError } from './outcomes';
import {
  beginJob,
  CANCELLED,
  downloadFailed,
  ensurePlan,
  loadImages,
  NO_PRODUCT_IMAGES,
  persistOutput,
  productImageSources,
  referenceSources,
  splitReferences,
  type Runtime,
} from './runtime';

// SPEC 10.3.
async function runImage(rt: Runtime, job: QueueJob, signal: AbortSignal): Promise<JobOutcome> {
  const run = await beginJob(rt, job);
  if (run === null) return CANCELLED;
  const { ctx, config } = run;
  const outputIndex = job.outputIndex ?? 0;

  const plan = await ensurePlan(rt, run);
  const shot = plan.imageShots[outputIndex];
  if (shot === undefined) {
    return { kind: 'failed', error: failure('internal', `The creative plan has no image shot ${outputIndex + 1}`, false) };
  }
  const productSources = productImageSources(ctx).slice(0, config.ai.image.maxProductImages);
  if (productSources.length === 0) return NO_PRODUCT_IMAGES;

  const safe = isSafeAttempt(job);
  const template = rt.getPrompt('image.user');
  const prompt = renderImagePrompt(template.text, plan, shot, config, { safe });
  const audit = { promptVersion: template.version, renderedPrompt: prompt };

  try {
    // Common references are style only; the product's own uploads are already part of productSources.
    const [productImages, styleReferences] = await Promise.all([
      loadImages(rt, productSources, signal),
      // The safer retry leaves the style references out: they may show the people the filter objected to.
      safe ? Promise.resolve([]) : loadImages(rt, referenceSources(splitReferences(ctx).style, 'image').slice(0, config.ai.image.maxStyleReferences), signal),
    ]);
    const generated = await rt.ai.getProvider(ctx.config.provider).generateImage({
      model: ctx.config.models.image,
      location: ctx.config.locations.image,
      signal,
      parts: buildImageParts({ productImages, styleReferences, prompt }, config),
      aspectRatio: ctx.config.image.aspectRatio,
      imageSize: ctx.config.image.imageSize,
      outputMimeType: ctx.config.image.outputMimeType,
    });
    if (!generated.ok) return outcomeFromGenerationError(generated.error, job, audit);

    const stored = await persistOutput(rt, {
      job,
      ctx,
      kind: 'image',
      mimeType: generated.value.mimeType,
      bytes: generated.value.bytes,
      shotTitle: shot.title,
    });
    if (!stored.ok) return { ...stored.outcome, audit };
    return {
      kind: 'succeeded',
      output: { mediaAssetId: stored.media.id, providerResponseId: generated.value.responseId, modelVersion: generated.value.modelVersion },
      audit,
    };
  } catch (err) {
    const outcome = downloadFailed(err);
    if (outcome === null) throw err;
    return outcome;
  }
}

export function createImageHandler(rt: Runtime): JobHandler {
  return { type: 'image', run: (job, signal) => runImage(rt, job, signal) };
}
