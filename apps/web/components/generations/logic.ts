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
import { archiveFileName, planArchive, type ArchiveFile, type ArchiveGroup } from '@/lib/archive';
import { sanitizeFilename } from '@/lib/download-policy';
import type { DownloadOutcome, ZipDownloadResult } from '@/lib/download';

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

// The outputs of a product, named like the single downloads, for the folder of that product in a zip.
export function archiveGroupOf(item: BatchItemView): ArchiveGroup {
  return {
    title: item.title,
    files: usableOutputs(item).map((media, position) => ({
      url: media.url,
      filename: outputFilename(item.title, media, position + 1),
    })),
  };
}

// Every ready output of the batch, in a folder per product.
export function batchArchiveFiles(batch: Pick<BatchDetail, 'items'>): ArchiveFile[] {
  return planArchive(batch.items.map(archiveGroupOf));
}

// Every ready output of one product, in a folder named after it.
export function productArchiveFiles(item: BatchItemView): ArchiveFile[] {
  return planArchive([archiveGroupOf(item)]);
}

export const DOWNLOAD_ALL_LABEL = 'Download all (.zip)';
export const DOWNLOAD_PRODUCT_LABEL = 'Download (.zip)';

// The file being fetched is the one after those done: "Preparing 4 of 9 files...".
export const archiveProgressLabel = (done: number, total: number): string =>
  `Preparing ${Math.min(done + 1, total)} of ${total} files...`;

// A zip being built: for the whole batch (scope BATCH_SCOPE) or for the product with the item id as scope.
export const BATCH_SCOPE = 'batch';

export interface ArchiveProgress {
  scope: string;
  // Files fetched (or skipped) so far, and files in all.
  done: number;
  total: number;
}

// The label for the button of a scope while its zip is built, or null when the running zip is another one.
export function zipProgressOf(archive: ArchiveProgress | null, scope: string): string | null {
  return archive !== null && archive.scope === scope ? archiveProgressLabel(archive.done, archive.total) : null;
}

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

const LISTED_FAILURES = 3;

// "a.jpg, b.jpg and 2 more"
function listNames(paths: readonly string[]): string {
  const names = paths.slice(0, LISTED_FAILURES).map(archiveFileName);
  const rest = paths.length - names.length;
  return rest > 0 ? `${names.join(', ')} and ${rest} more` : names.join(', ');
}

// The toast after "Download (.zip)", or null when the merchant left the page and nothing is to be said. Files that
// could not be fetched are named, so a partly filled zip does not go unnoticed.
export function archiveToast(result: ZipDownloadResult, archiveName: string): ToastText | null {
  const { outcome, added, total, skipped } = result;
  switch (outcome) {
    case 'cancelled':
      return null;
    case 'too_large':
      return { message: 'These files are too large for one zip. Download fewer products at a time.', isError: true };
    case 'failed':
      return { message: 'Could not download the files. Try again.', isError: true };
    case 'opened':
      return { message: 'Could not save the zip, it was opened in a new tab', isError: false };
    case 'saved':
      if (skipped.length === 0) return { message: `Saved ${archiveName} with ${plural(added, 'file')}`, isError: false };
      return {
        message: `Saved ${added} of ${total} files in ${archiveName}. Could not download ${listNames(skipped)}.`,
        isError: true,
      };
  }
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
