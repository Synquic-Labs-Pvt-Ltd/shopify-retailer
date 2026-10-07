import type { BatchConfigSnapshot, CreativePlan, GenerationConfig, MediaObject, PlanCounts, ProductSnapshot } from '@rs/shared';
import { AppError } from '../../core/errors';
import type { LoadedPrompt, PromptName } from '../../core/config';
import type { Logger } from '../../core/logger';
import { buildFallbackPlan, type AiService, type ImageInput } from '../ai';
import type { BatchItemContext, BatchesService } from '../batches';
import type { MediaAssetRecord, MediaService } from '../media';
import type { JobOutcome, QueueJob } from '../queue';
import { DownloadError, downloadBytes } from './download';
import { failure } from './outcomes';

// The slice of the batches service the handlers use.
export type HandlerBatches = Pick<BatchesService, 'getItemContext' | 'markBatchStarted' | 'markItemPlanning' | 'setCreativePlan'>;

export interface GenerationDeps {
  ai: AiService;
  batches: HandlerBatches;
  media: Pick<MediaService, 'storage'>;
  // Live: ai.* caps and queue settings. Provider, models, locations, image, video and counts come from the
  // batch's frozen snapshot.
  getConfig: () => GenerationConfig;
  getPrompt: (name: PromptName) => LoadedPrompt;
  logger: Logger;
  // Downloads of product and reference bytes. Defaults to the global fetch.
  fetchImpl?: typeof fetch;
  now?: () => Date;
}

export interface Runtime {
  ai: AiService;
  batches: HandlerBatches;
  media: Pick<MediaService, 'storage'>;
  getConfig: () => GenerationConfig;
  getPrompt: (name: PromptName) => LoadedPrompt;
  logger: Logger;
  fetchImpl: typeof fetch;
  now: () => Date;
}

export function createRuntime(deps: GenerationDeps): Runtime {
  return {
    ai: deps.ai,
    batches: deps.batches,
    media: deps.media,
    getConfig: deps.getConfig,
    getPrompt: deps.getPrompt,
    logger: deps.logger.child({ module: 'generation' }),
    fetchImpl: deps.fetchImpl ?? fetch,
    now: deps.now ?? (() => new Date()),
  };
}

// What one job run works with: the item context plus the live config overlaid with the batch snapshot,
// the shape the ai prompt helpers expect.
export interface JobRun {
  ctx: BatchItemContext;
  config: GenerationConfig;
}

export function effectiveConfig(live: GenerationConfig, frozen: BatchConfigSnapshot): GenerationConfig {
  return {
    ...live,
    outputs: frozen.outputs,
    provider: frozen.provider,
    models: frozen.models,
    locations: frozen.locations,
    image: frozen.image,
    video: frozen.video,
  };
}

export function planCounts(frozen: BatchConfigSnapshot): PlanCounts {
  return { imageCount: frozen.outputs.imagesPerProduct, videoCount: frozen.outputs.videosPerProduct };
}

// Marks the batch as started and returns null when the job must not run: the batch was cancelled or its
// data is gone.
export async function beginJob(rt: Runtime, job: QueueJob): Promise<JobRun | null> {
  let ctx: BatchItemContext;
  try {
    ctx = await rt.batches.getItemContext(job.shopId, job.batchItemId);
  } catch (err) {
    if (err instanceof AppError && err.code === 'not_found') return null;
    throw err;
  }
  if (ctx.cancelRequested) return null;
  await rt.batches.markBatchStarted(job.shopId, job.batchId);
  return { ctx, config: effectiveConfig(rt.getConfig(), ctx.config) };
}

export const CANCELLED: JobOutcome = { kind: 'cancelled' };

export const NO_PRODUCT_IMAGES: JobOutcome = {
  kind: 'failed',
  error: failure('invalid_request', 'The product has no images to work from', false),
};

export interface MediaSource {
  url: string;
  mimeType: string;
}

// Featured image first, without duplicates.
export function productImageSources(snapshot: ProductSnapshot): MediaSource[] {
  const urls = [snapshot.featuredImageUrl, ...snapshot.imageUrls].filter((url): url is string => url !== null && url.length > 0);
  return [...new Set(urls)].map((url) => ({ url, mimeType: 'image/jpeg' }));
}

export function referenceSources(references: readonly MediaAssetRecord[], type: 'image' | 'video'): (MediaSource & { asset: MediaAssetRecord })[] {
  return references.flatMap((asset) =>
    asset.mediaType === type && asset.url !== null ? [{ url: asset.url, mimeType: asset.mimeType, asset }] : [],
  );
}

export async function loadImages(rt: Runtime, sources: readonly MediaSource[], signal: AbortSignal): Promise<ImageInput[]> {
  const files = await Promise.all(sources.map((source) => downloadBytes(rt.fetchImpl, source.url, signal, source.mimeType)));
  return files.map((file) => ({ mimeType: file.mimeType, data: file.bytes }));
}

// A missing plan means the plan job failed or was cancelled: build the fallback (SPEC 10.2) and store it.
// First write wins, so a plan another job stored meanwhile is the one returned.
export async function ensurePlan(rt: Runtime, run: JobRun): Promise<CreativePlan> {
  if (run.ctx.creativePlan !== null) return run.ctx.creativePlan;
  const fallback = buildFallbackPlan(run.ctx.productSnapshot, planCounts(run.ctx.config), run.config);
  const stored = await rt.batches.setCreativePlan(run.ctx.shopId, run.ctx.itemId, fallback, 'fallback');
  return stored.plan;
}

export function downloadFailed(err: unknown): JobOutcome | null {
  return err instanceof DownloadError ? { kind: 'retry', error: failure('transient', err.message, true) } : null;
}

const EXTENSIONS: Record<string, string> = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' };

function slug(value: string): string {
  const cleaned = value.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '');
  return cleaned.length > 0 ? cleaned : 'product';
}

// SPEC 8.6: rs-{productHandle}-{batchShort}-img{n}.jpg and rs-{productHandle}-{batchShort}-vid{n}.mp4.
export function outputFilename(ctx: BatchItemContext, kind: 'image' | 'video', outputIndex: number, mimeType: string): string {
  const batchShort = ctx.batchId.slice(-6);
  const tag = `${kind === 'image' ? 'img' : 'vid'}${outputIndex + 1}`;
  const extension = kind === 'video' ? 'mp4' : (EXTENSIONS[mimeType] ?? 'jpg');
  return `rs-${slug(ctx.productSnapshot.handle)}-${batchShort}-${tag}.${extension}`;
}

export interface OutputToPersist {
  job: QueueJob;
  ctx: BatchItemContext;
  kind: 'image' | 'video';
  mimeType: string;
  bytes: Uint8Array;
  shotTitle: string;
}

export type PersistResult = { ok: true; media: MediaObject } | { ok: false; outcome: Extract<JobOutcome, { kind: 'retry' }> };

// Idempotent per job (the storage driver looks up sourceJobId first). A storage failure is a retry.
export async function persistOutput(rt: Runtime, output: OutputToPersist): Promise<PersistResult> {
  const { job, ctx } = output;
  try {
    const media = await rt.media.storage.persistOutput({
      shopId: ctx.shopId,
      createdByUserId: ctx.createdByUserId,
      batchId: ctx.batchId,
      batchItemId: ctx.itemId,
      sourceJobId: job.id,
      productGid: ctx.productGid,
      mediaType: output.kind,
      mimeType: output.mimeType,
      bytes: output.bytes,
      filename: outputFilename(ctx, output.kind, job.outputIndex ?? 0, output.mimeType),
      alt: `${ctx.productSnapshot.title}: ${output.shotTitle}`,
      shotTitle: output.shotTitle,
    });
    return { ok: true, media };
  } catch (err) {
    rt.logger.warn({ err, jobId: job.id, type: job.type }, 'persisting an output failed');
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, outcome: { kind: 'retry', error: failure('shopify_upload_failed', `Could not store the output: ${message}`, true) } };
  }
}
