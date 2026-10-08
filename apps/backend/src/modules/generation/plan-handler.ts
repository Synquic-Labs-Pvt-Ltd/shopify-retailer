import { createCreativePlanSchema, type CreativePlan } from '@rs/shared';
import {
  buildPlannerParts,
  renderPlannerSystemPrompt,
  type AiResult,
  type ImageInput,
  type PlanResponse,
  type ReferenceVideoInput,
} from '../ai';
import type { JobHandler, JobOutcome, QueueJob } from '../queue';
import { DownloadError, downloadBytes, MAX_DOWNLOAD_BYTES } from './download';
import { failure, outcomeFromAiError } from './outcomes';
import {
  beginJob,
  CANCELLED,
  downloadFailed,
  loadImages,
  NO_PRODUCT_IMAGES,
  planCounts,
  productImageSources,
  referenceSources,
  splitReferences,
  type JobRun,
  type Runtime,
} from './runtime';

// A product video the merchant uploaded for one product (it shows the exact product in motion).
const MAX_PLANNER_PRODUCT_VIDEOS = 2;

type VideoSource = ReturnType<typeof referenceSources>[number];

interface PlannerInputs {
  // Every product image up to the planner cap: the planner reads them all to describe the exact product.
  productImages: ImageInput[];
  referenceImages: ImageInput[];
  productVideos: VideoSource[];
  styleVideos: VideoSource[];
}

async function loadInputs(rt: Runtime, run: JobRun, signal: AbortSignal): Promise<PlannerInputs> {
  const { ctx, config } = run;
  const split = splitReferences(ctx);
  const [productImages, referenceImages] = await Promise.all([
    loadImages(rt, productImageSources(ctx).slice(0, config.ai.planner.maxProductImages), signal),
    loadImages(rt, referenceSources(split.style, 'image').slice(0, config.ai.planner.maxReferenceImages), signal),
  ]);
  return {
    productImages,
    referenceImages,
    productVideos: referenceSources(split.own, 'video').slice(0, MAX_PLANNER_PRODUCT_VIDEOS),
    styleVideos: referenceSources(split.style, 'video').slice(0, config.ai.planner.maxReferenceVideos),
  };
}

// The provider rejected the video urls: send the files that are small enough inline and skip the rest.
async function inlineVideos(rt: Runtime, videos: readonly VideoSource[], signal: AbortSignal) {
  const inputs: ReferenceVideoInput[] = [];
  const warnings: string[] = [];
  for (const video of videos) {
    if (video.asset.fileSize > MAX_DOWNLOAD_BYTES) {
      warnings.push(`Reference video "${video.asset.filename}" was skipped: the provider rejected its url and it is larger than 20 MB.`);
      continue;
    }
    try {
      const file = await downloadBytes(rt.fetchImpl, video.url, signal, video.mimeType);
      inputs.push({ mimeType: file.mimeType, data: file.bytes });
    } catch (err) {
      if (!(err instanceof DownloadError)) throw err;
      warnings.push(`Reference video "${video.asset.filename}" was skipped: it could not be downloaded.`);
    }
  }
  return { inputs, warnings };
}

async function runPlan(rt: Runtime, job: QueueJob, signal: AbortSignal): Promise<JobOutcome> {
  const run = await beginJob(rt, job);
  if (run === null) return CANCELLED;
  const { ctx, config } = run;
  await rt.batches.markItemPlanning(ctx.shopId, ctx.itemId);
  // Already planned (a retried plan job, or a replay after a lost lease): nothing left to do.
  if (ctx.creativePlan !== null) return { kind: 'succeeded' };
  if (productImageSources(ctx).length === 0) return NO_PRODUCT_IMAGES;

  const counts = planCounts(ctx.config);
  const template = rt.getPrompt('planner.system');
  const systemPrompt = renderPlannerSystemPrompt(template.text, counts, config);
  const audit = { promptVersion: template.version, renderedPrompt: systemPrompt };
  const provider = rt.ai.getProvider(ctx.config.provider);

  try {
    const inputs = await loadInputs(rt, run, signal);
    const call = (referenceVideos: ReferenceVideoInput[], productVideos: ReferenceVideoInput[]): Promise<AiResult<PlanResponse>> =>
      provider.plan({
        model: ctx.config.models.planner,
        location: ctx.config.locations.planner,
        signal,
        systemPrompt,
        parts: buildPlannerParts(
          {
            snapshot: ctx.productSnapshot,
            productImages: inputs.productImages,
            productVideos,
            referenceImages: inputs.referenceImages,
            referenceVideos,
            counts,
          },
          config,
        ),
        imageCount: counts.imageCount,
        videoCount: counts.videoCount,
        temperature: config.ai.planner.temperature,
      });

    let warnings: string[] = [];
    const byUrl = (videos: readonly VideoSource[]): ReferenceVideoInput[] => videos.map((video) => ({ mimeType: video.mimeType, uri: video.url }));
    let result = await call(byUrl(inputs.styleVideos), byUrl(inputs.productVideos));
    if (!result.ok && result.error.kind === 'invalid_request' && inputs.styleVideos.length + inputs.productVideos.length > 0) {
      const style = await inlineVideos(rt, inputs.styleVideos, signal);
      const product = await inlineVideos(rt, inputs.productVideos, signal);
      warnings = [...style.warnings, ...product.warnings];
      result = await call(style.inputs, product.inputs);
    }
    if (!result.ok) return outcomeFromAiError(result.error, audit);

    const parsed = createCreativePlanSchema(counts).safeParse(result.value.json);
    if (!parsed.success) {
      const issues = parsed.error.issues.slice(0, 3).map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`);
      return { kind: 'retry', error: failure('no_output', `The planner returned an invalid plan (${issues.join('; ')})`, true), audit };
    }
    const plan: CreativePlan = { ...parsed.data, warnings: [...parsed.data.warnings, ...warnings] };
    await rt.batches.setCreativePlan(ctx.shopId, ctx.itemId, plan, 'planner');
    return {
      kind: 'succeeded',
      output: { mediaAssetId: null, providerResponseId: result.value.responseId, modelVersion: result.value.modelVersion },
      audit,
    };
  } catch (err) {
    const outcome = downloadFailed(err);
    if (outcome === null) throw err;
    return outcome;
  }
}

export function createPlanHandler(rt: Runtime): JobHandler {
  return { type: 'plan', run: (job, signal) => runPlan(rt, job, signal) };
}
