import { buildImageParts, imageInputBudget, renderImagePrompt } from '../ai';
import type { JobHandler, JobOutcome, QueueJob } from '../queue';
import { failure, isSafeAttempt, outcomeFromGenerationError } from './outcomes';
import {
  beginJob,
  CANCELLED,
  downloadFailed,
  ensurePlanWithSource,
  loadImages,
  NO_PRODUCT_IMAGES,
  outputPrompts,
  persistOutput,
  productImageSources,
  promptAudit,
  promptRefOf,
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

  const { plan, source: planSource } = await ensurePlanWithSource(rt, run);
  const shot = plan.imageShots[outputIndex];
  if (shot === undefined) {
    return { kind: 'failed', error: failure('internal', `The creative plan has no image shot ${outputIndex + 1}`, false) };
  }
  const allProducts = productImageSources(ctx);
  if (allProducts.length === 0) return NO_PRODUCT_IMAGES;

  const safe = isSafeAttempt(job);
  // The safer retry leaves the style references out: they may show the people the filter objected to.
  const allStyles = safe ? [] : referenceSources(splitReferences(ctx).style, 'image');
  // The model takes few images and uses the later ones unreliably: the style reference keeps its place and the
  // product images fill the rest (SPEC 10.3).
  const budget = imageInputBudget(config.ai.image, { styles: allStyles.length, products: allProducts.length });
  const productSources = allProducts.slice(0, budget.products);
  const styleSources = allStyles.slice(0, budget.styles);

  const template = await rt.resolvePrompt(ctx.shopId, 'image.user', promptRefOf(ctx.config, 'image'));
  const prompt = renderImagePrompt(template.text, plan, shot, config, { safe, scene: styleSources.length > 0 });
  const audit = promptAudit(template, prompt);

  try {
    // Common references are style only; the product's own uploads are already part of productSources.
    const [productImages, styleReferences] = await Promise.all([
      loadImages(rt, productSources, signal),
      loadImages(rt, styleSources, signal),
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
      prompts: outputPrompts(ctx.config, planSource, 'image'),
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
