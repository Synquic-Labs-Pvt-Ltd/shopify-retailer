import { productGidSchema } from '@rs/shared';
import { summarizeProblems, type AddFilesResult } from '@/lib/references/addFiles';
import type { ProductResolution } from '@/lib/references/resolution';
import type { DraftData, DraftReference } from '@/lib/state/draftTypes';

// Pure rules and copy of the New generation page.

type DraftSlice = Pick<DraftData, 'products' | 'commonRefs' | 'productRefs'>;

export type BadgeTone = 'info' | 'neutral' | 'warning';

function plural(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`;
}

export function unresolvedBanner(count: number): { heading: string; body: string } {
  return {
    heading: count === 1 ? '1 product needs a reference.' : `${count} products need a reference.`,
    body: 'Add references to each product, or add common references that apply to every product.',
  };
}

export function generateLabel(productCount: number): string {
  return `Generate ${plural(productCount, 'product', 'products')}`;
}

export interface OutputTotals {
  images: number;
  videos: number;
  total: number;
}

export function outputTotals(productCount: number, imagesPerProduct: number, videosPerProduct: number): OutputTotals {
  const images = productCount * imagesPerProduct;
  const videos = productCount * videosPerProduct;
  return { images, videos, total: images + videos };
}

export function outputsLabel({ images, videos, total }: OutputTotals): string {
  return `${total} (${plural(images, 'image', 'images')}, ${plural(videos, 'video', 'videos')})`;
}

export function readyProductsLabel(ready: number, total: number): string {
  return `${ready} of ${plural(total, 'product', 'products')}`;
}

export function referenceCountLabel(count: number, max: number): string {
  return `${count} of ${max} added`;
}

// The badge of a product row. A product the server named in a 422 shows as unresolved until the draft changes.
export function resolutionBadge(
  resolution: Pick<ProductResolution, 'mode' | 'label' | 'unresolved'>,
  flaggedByServer: boolean,
): { label: string; tone: BadgeTone } {
  if (resolution.unresolved || flaggedByServer) return { label: 'Needs a reference', tone: 'warning' };
  return { label: resolution.label, tone: resolution.mode === 'common_only' ? 'neutral' : 'info' };
}

// The slots that take part in the batch: the common ones and those of the selected products.
export function participatingRefs(draft: DraftSlice): DraftReference[] {
  return [...draft.commonRefs, ...draft.products.flatMap((product) => draft.productRefs[product.id] ?? [])];
}

export interface SlotCounts {
  uploading: number;
  processing: number;
  failed: number;
  ready: number;
}

export function slotCounts(draft: DraftSlice): SlotCounts {
  const counts: SlotCounts = { uploading: 0, processing: 0, failed: 0, ready: 0 };
  for (const ref of participatingRefs(draft)) counts[ref.status] += 1;
  return counts;
}

// Why Generate is still disabled although every product has a reference, or null when nothing is pending.
export function generateHint(counts: SlotCounts): string | null {
  if (counts.failed > 0) {
    return counts.failed === 1
      ? 'Retry or remove the failed reference to continue.'
      : 'Retry or remove the failed references to continue.';
  }
  if (counts.uploading + counts.processing > 0) return 'Waiting for uploads to finish.';
  return null;
}

export interface GenerateState {
  hydrated: boolean;
  submitting: boolean;
  productCount: number;
  unresolvedCount: number;
  slotsReady: boolean;
}

export function canGenerate(state: GenerateState): boolean {
  return (
    state.hydrated &&
    !state.submitting &&
    state.productCount > 0 &&
    state.unresolvedCount === 0 &&
    state.slotsReady
  );
}

// "0:08" for a video tile. Empty when the length is unknown.
export function formatDuration(seconds: number | null): string {
  if (seconds === null || !Number.isFinite(seconds) || seconds < 0) return '';
  const whole = Math.round(seconds);
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, '0')}`;
}

// The drop zone reports a file through both its input and change events, and keeps the files until it is
// reset. Every File object is handled once.
export function takeNewFiles(files: readonly File[], seen: WeakSet<File>): File[] {
  const fresh = files.filter((file) => !seen.has(file));
  for (const file of fresh) seen.add(file);
  return fresh;
}

// The single toast for the outcome of adding files, or null when there is nothing to tell. Uploads the browser
// blocked are explained by a banner instead.
export function addResultMessage(result: Pick<AddFilesResult, 'problems' | 'uploads'>): string | null {
  if (result.problems.length > 0) return summarizeProblems(result.problems);
  const { failed, blocked } = result.uploads;
  if (failed === 0 || blocked) return null;
  return failed === 1 ? 'An upload failed. Retry it or remove it.' : `${failed} uploads failed. Retry them or remove them.`;
}

export function processingFailedMessage(count: number): string {
  return count === 1 ? 'A reference could not be processed.' : `${count} references could not be processed.`;
}

export const RETRY_FAILED_MESSAGE = 'The upload failed again. Check the message under the slot.';
export const BLOCKED_UPLOAD_MESSAGE = 'The browser could not upload straight to Shopify. Try again, or contact support.';
export const SETTINGS_LOADING_MESSAGE = 'Generation settings are still loading. Try again in a moment.';

// Every image and video type is offered; the pipeline then explains the ones it cannot use (HEIC, for one).
export const FILE_ACCEPT = 'image/*,video/*';

export interface DeepLinkOutcome {
  invalid: number;
  truncated: number;
  // Products that could not be fetched.
  failed: number;
  // Products cut because the selection already held the cap.
  dropped: number;
}

// One sentence for what went wrong while /generate?ids= was preselecting products, or null when all went well.
export function deepLinkMessage({ invalid, truncated, failed, dropped }: DeepLinkOutcome): string | null {
  const skipped = invalid + failed;
  const cut = truncated + dropped;
  const parts: string[] = [];
  if (skipped > 0) parts.push(`${plural(skipped, 'product', 'products')} could not be added.`);
  if (cut > 0) parts.push(`${plural(cut, 'product was', 'products were')} left out because of the batch limit.`);
  return parts.length === 0 ? null : parts.join(' ');
}

export interface ParsedProductIds {
  ids: string[];
  invalid: number;
  // Valid ids cut because the batch is capped.
  truncated: number;
}

// /generate?ids=gid1,gid2: the product GIDs a Shopify admin action hands over. Duplicates and anything that is
// not a Shopify product GID are dropped; at most `max` ids are kept.
export function parseProductIds(raw: string | null | undefined, max: number): ParsedProductIds {
  const candidates = [...new Set((raw ?? '').split(',').map((part) => part.trim()).filter((part) => part !== ''))];
  const valid = candidates.filter((candidate) => productGidSchema.safeParse(candidate).success);
  const ids = valid.slice(0, Math.max(0, max));
  return { ids, invalid: candidates.length - valid.length, truncated: valid.length - ids.length };
}
