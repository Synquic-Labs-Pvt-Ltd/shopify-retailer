import {
  ApiError,
  isTerminalBatchStatus,
  objectIdSchema,
  type BatchCounts,
  type BatchDetail,
  type BatchItemView,
  type BatchStatus,
  type BatchSummary,
  type JobType,
} from '@rs/shared';
import { plural } from '@/lib/batch/format';
import { usableOutputs, type ResultTileModel, type UsableOutput } from '@/lib/batch/outputs';
import { sanitizeFilename } from '@/lib/download-policy';
import type { DownloadItem, DownloadOutcome, DownloadSummary } from '@/lib/download';

// Pure rules of the Generations pages: list filter, labels, file names, viewer navigation and toast texts.

export const BATCH_TABS = ['all', 'running', 'completed', 'errors'] as const;
export type BatchTab = (typeof BATCH_TABS)[number];

export const BATCH_TAB_LABELS: Record<BatchTab, string> = {
  all: 'All',
  running: 'Running',
  completed: 'Completed',
  errors: 'With errors',
};

// "Running" covers every batch that is not finished yet. "With errors" covers partial and failed batches.
export function matchesTab(status: BatchStatus, tab: BatchTab): boolean {
  switch (tab) {
    case 'all':
      return true;
    case 'running':
      return !isTerminalBatchStatus(status);
    case 'completed':
      return status === 'completed';
    case 'errors':
      return status === 'completed_with_errors' || status === 'failed';
  }
}

export function filterByTab<T extends { status: BatchStatus }>(batches: readonly T[], tab: BatchTab): T[] {
  return batches.filter((batch) => matchesTab(batch.status, tab));
}

export function isValidBatchId(id: string): boolean {
  return objectIdSchema.safeParse(id).success;
}

// A 404 and a malformed id are both "there is no such generation" for the merchant.
export function isBatchNotFound(error: unknown): boolean {
  return error instanceof ApiError && (error.code === 'not_found' || error.code === 'validation_failed');
}

export const canCancelBatch = (batch: Pick<BatchSummary, 'status'>): boolean => !isTerminalBatchStatus(batch.status);

export const canRetryFailed = (batch: Pick<BatchSummary, 'status' | 'counts'>): boolean =>
  isTerminalBatchStatus(batch.status) && batch.counts.jobsFailed > 0;

// "5 images, 2 videos", "1 image", "None yet".
export function readyText({ imagesReady, videosReady }: Pick<BatchCounts, 'imagesReady' | 'videosReady'>): string {
  const parts: string[] = [];
  if (imagesReady > 0) parts.push(plural(imagesReady, 'image'));
  if (videosReady > 0) parts.push(plural(videosReady, 'video'));
  return parts.length === 0 ? 'None yet' : parts.join(', ');
}

// Progress is 0 to 1; "58%".
export function percentText(progress: number): string {
  return `${Math.round(Math.min(1, Math.max(0, progress)) * 100)}%`;
}

export const outputsReady = (counts: Pick<BatchCounts, 'imagesReady' | 'videosReady'>): number =>
  counts.imagesReady + counts.videosReady;

export function outputsPerProduct(batch: Pick<BatchSummary, 'configSnapshot'>): number {
  const { imagesPerProduct, videosPerProduct } = batch.configSnapshot.outputs;
  return imagesPerProduct + videosPerProduct;
}

export const outputsTotal = (batch: Pick<BatchSummary, 'configSnapshot' | 'counts'>): number =>
  batch.counts.products * outputsPerProduct(batch);

function failedShotCount(item: BatchItemView): number {
  return item.jobs.filter((job) => job.type !== 'plan' && job.status === 'failed').length;
}

// "2 of 3 ready", "1 of 3 ready, 1 failed".
export function itemSummaryText(item: BatchItemView, expected: number): string {
  const ready = usableOutputs(item).length;
  const failed = failedShotCount(item);
  const base = expected > 0 ? `${ready} of ${Math.max(expected, ready)} ready` : `${ready} ready`;
  return failed > 0 ? `${base}, ${failed} failed` : base;
}

const FALLBACK_EXTENSION = { image: 'jpg', video: 'mp4' } as const;
const EXTENSION_PATTERN = /\.([A-Za-z0-9]{2,5})$/;

function pathnameOf(url: string): string {
  try {
    return new URL(url).pathname;
  } catch {
    return url;
  }
}

// From the media url, then the stored file name, then a default for the media type.
function extensionOf(media: UsableOutput): string {
  const found = EXTENSION_PATTERN.exec(pathnameOf(media.url))?.[1] ?? EXTENSION_PATTERN.exec(media.filename)?.[1];
  return (found ?? FALLBACK_EXTENSION[media.mediaType]).toLowerCase();
}

// "Linen camp-collar shirt!" -> "Linen-camp-collar-shirt"; accents are dropped, anything else becomes a dash.
function nameWord(text: string | null, fallback: string): string {
  const cleaned = (text ?? '')
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^A-Za-z0-9]+/g, '-')
    .replace(/^-+/, '')
    .slice(0, 40)
    .replace(/-+$/, '');
  return cleaned === '' ? fallback : cleaned;
}

// {productTitle}-{shotTitle or type}-{index}.{ext}, index counted from 1 within the product.
export function outputFilename(productTitle: string, media: UsableOutput, index: number): string {
  const extension = extensionOf(media);
  const product = nameWord(productTitle, 'product');
  const shot = nameWord(media.shotTitle, media.mediaType);
  return sanitizeFilename(`${product}-${shot}-${index}.${extension}`, `${media.mediaType}-${index}.${extension}`);
}

export function downloadItemsOf(item: BatchItemView): DownloadItem[] {
  return usableOutputs(item).map((media, position) => ({
    url: media.url,
    filename: outputFilename(item.title, media, position + 1),
  }));
}

export function downloadItemsOfBatch(batch: Pick<BatchDetail, 'items'>): DownloadItem[] {
  return batch.items.flatMap(downloadItemsOf);
}

export const downloadAllLabel = (count: number): string => `Download all (${count})`;

// done files are finished while the next one is being saved: "Saving 2 of 6".
export const savingLabel = (done: number, total: number): string => `Saving ${Math.min(done + 1, total)} of ${total}`;

export interface ToastText {
  message: string;
  isError: boolean;
}

export function singleDownloadToast(outcome: DownloadOutcome): ToastText {
  switch (outcome) {
    case 'saved':
      return { message: 'Saved', isError: false };
    case 'opened':
      return { message: 'Could not save the file, it was opened in a new tab', isError: false };
    case 'failed':
      return { message: 'Could not save the file. Try again.', isError: true };
  }
}

export function downloadSummaryToast({ saved, failed }: DownloadSummary): ToastText {
  if (failed === 0) return { message: `Saved ${plural(saved, 'file')}`, isError: false };
  if (saved === 0) return { message: 'Could not save the files. Try again.', isError: true };
  return { message: `Saved ${saved}, ${failed} failed`, isError: true };
}

// The media viewer shows the outputs of one product. It is addressed by media id, so a poll that adds an output
// before the current one does not move the viewer.
export interface ViewerTarget {
  itemId: string;
  mediaId: string;
}

export function viewerTargetOf(tile: ResultTileModel, itemId: string): ViewerTarget | null {
  return tile.kind === 'output' ? { itemId, mediaId: tile.media.id } : null;
}

// -1 when the media is not among the outputs.
export function viewerIndex(outputs: readonly { id: string }[], mediaId: string): number {
  return outputs.findIndex((output) => output.id === mediaId);
}

// The media id one step away, or null at either end (no wrap-around) and for an unknown media id.
export function neighbourId(outputs: readonly { id: string }[], mediaId: string, delta: 1 | -1): string | null {
  const index = viewerIndex(outputs, mediaId);
  if (index < 0) return null;
  return outputs[index + delta]?.id ?? null;
}

export const viewerCounter = (index: number, count: number): string => `${index + 1} / ${count}`;

export function arrowKeyDelta(key: string): 1 | -1 | null {
  if (key === 'ArrowRight') return 1;
  if (key === 'ArrowLeft') return -1;
  return null;
}

// The pending tile key is built by resultTiles as pending-{jobType}-{outputIndex}.
export function pendingTileLabel(key: string): string {
  return key.startsWith('pending-video') ? 'Video in progress' : 'Image in progress';
}

export const failedTileTitle = (jobType: JobType): string => (jobType === 'video' ? 'Video failed' : 'Image failed');
