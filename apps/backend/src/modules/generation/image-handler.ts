import { backImageShotIndex } from '@rs/shared';
import { buildImageParts, imageFormatOf, imageInputBudget, imageSizeOf, isMannequinOnlyProduct, MIME_OF_FORMAT, renderImagePrompt } from '../ai';
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
  // Intimate wear, swimwear and infant garments never show a person: they get the no-person presentation on the first
  // attempt too. Only a safety block also drops the style references (nothing blocked these).
  const noPerson = safe || isMannequinOnlyProduct(ctx.productSnapshot);
  // The safer retry leaves the style references out: they may show the people the filter objected to.
  const allStyles = safe ? [] : referenceSources(splitReferences(ctx).style, 'image');
  // The model takes few images and uses the later ones unreliably: the style reference keeps its place and the
  // product images fill the rest (SPEC 10.3).
  const budget = imageInputBudget(config.ai.image, { styles: allStyles.length, products: allProducts.length });
  const productSources = allProducts.slice(0, budget.products);
  const styleSources = allStyles.slice(0, budget.styles);

  const template = await rt.resolvePrompt(ctx.shopId, 'image.user', promptRefOf(ctx.config, 'image'));
  // The last image shot of every product is its back view, whatever the plan or the prompt version says.
  const back = outputIndex === backImageShotIndex(plan.imageShots.length);
  const prompt = renderImagePrompt(template.text, plan, shot, config, { safe: noPerson, scene: styleSources.length > 0, back });
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
    // What the model really returned: the quality a merchant gets is the size and format of this file. The type is read
    // from the bytes, not from the model's label (a JPEG has come back labeled image/png, which named the file .png).
    const size = imageSizeOf(generated.value.bytes);
    const format = imageFormatOf(generated.value.bytes);
    const mimeType = format === null ? generated.value.mimeType : MIME_OF_FORMAT[format];
    if (mimeType !== generated.value.mimeType) {
      rt.logger.warn(
        { jobId: job.id, model: ctx.config.models.image, declaredMimeType: generated.value.mimeType, actualMimeType: mimeType },
        'the model labeled the image with the wrong type: storing it under its real type',
      );
    }
    rt.logger.info(
      {
        jobId: job.id,
        model: ctx.config.models.image,
        mimeType,
        declaredMimeType: generated.value.mimeType,
        bytes: generated.value.bytes.byteLength,
        width: size?.width ?? null,
        height: size?.height ?? null,
        requestedSize: ctx.config.image.imageSize,
        requestedMimeType: ctx.config.image.outputMimeType,
      },
      'image generated',
    );

    const stored = await persistOutput(rt, {
      job,
      ctx,
      kind: 'image',
      mimeType,
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
