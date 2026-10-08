import { ApiError, type AttachMediaResponse, type BatchDetail, type BatchItemView, type MediaObject } from '@rs/shared';
import { errorMessage } from '@/lib/api/errors';
import { plural } from '@/lib/batch/format';
import { usableOutputs } from '@/lib/batch/outputs';
import type { ToastText } from './logic';

// Pure rules of "Add to products": which products can take their outputs, what the buttons say, and how the answer
// of POST /batches/:id/attach-media is told to the merchant.

// 'none': no ready output yet. 'ready': at least one ready output is not on the product yet (including outputs that
// arrived after an earlier add). 'done': every ready output is on the product.
export type AttachState = 'none' | 'ready' | 'done';

const isAttached = (media: Pick<MediaObject, 'attachedAt'>): boolean =>
  media.attachedAt !== null && media.attachedAt !== undefined;

export function attachState(item: BatchItemView): AttachState {
  const outputs = usableOutputs(item);
  if (outputs.length === 0) return 'none';
  return outputs.every(isAttached) ? 'done' : 'ready';
}

// The products that have something to add.
export function attachableItems(batch: Pick<BatchDetail, 'items'>): BatchItemView[] {
  return batch.items.filter((item) => attachState(item) === 'ready');
}

// The batch button: ready while any product has something to add, done once every product that has outputs has them
// on the product, none while nothing is ready.
export function batchAttachState(batch: Pick<BatchDetail, 'items'>): AttachState {
  const states = batch.items.map(attachState);
  if (states.includes('ready')) return 'ready';
  return states.includes('done') ? 'done' : 'none';
}

export const BATCH_ATTACH_LABEL = 'Add to products';
export const BATCH_ATTACHED_LABEL = 'Added to products';
export const ITEM_ATTACH_LABEL = 'Add to product';
export const ITEM_ATTACHED_LABEL = 'Added to product';

export const ATTACH_MODAL_HEADING = 'Add the outputs to your products?';
export const ATTACH_MODAL_BODY = 'The generated images and videos will be added to the media of each product in your Shopify store.';

export function attachConfirmText(productCount: number): string {
  return `This changes ${plural(productCount, 'product')} in your store. You can remove the media later from the product page in Shopify.`;
}

type TitleOf = (itemId: string) => string;

export const titleResolver =
  (batch: Pick<BatchDetail, 'items'>): TitleOf =>
  (itemId) =>
    batch.items.find((item) => item.id === itemId)?.title ?? 'the product';

// "Added 3 files to Lamp, 1 already on the product" / "Added 12 files to 4 products" / "2 files already on the
// product". Failed files make it an error toast; the page also shows a banner with the reason.
export function attachToast(response: AttachMediaResponse, titleOf: TitleOf): ToastText {
  const { attached, alreadyAttached, failed, items } = response;
  const single = items.length === 1 ? items[0] : undefined;
  const target =
    single === undefined ? plural(items.filter((row) => row.attached > 0).length, 'product') : titleOf(single.itemId);
  const there = single === undefined ? 'the products' : 'the product';

  const parts: string[] = [];
  if (attached > 0) parts.push(`Added ${plural(attached, 'file')} to ${target}`);
  if (alreadyAttached > 0) {
    parts.push(attached > 0 ? `${alreadyAttached} already on ${there}` : `${plural(alreadyAttached, 'file')} already on ${there}`);
  }
  if (failed > 0) parts.push(`${failed} could not be added`);
  return { message: parts.length === 0 ? 'No finished outputs to add yet' : parts.join(', '), isError: failed > 0 };
}

// A dismissible banner for what went wrong.
export interface AttachNotice {
  heading: string;
  message: string;
  hint: string;
}

const PARTIAL_HINT = 'Products that were updated keep their new media. Check that the app may edit products, then try again.';

// One banner for every product that failed: the first reason, and how many more products had one.
export function attachNotice(response: AttachMediaResponse, titleOf: TitleOf): AttachNotice | null {
  const failures = response.items.filter((row) => row.failed > 0);
  const [first] = failures;
  if (first === undefined) return null;
  const reason = first.error !== null && first.error !== '' ? first.error : 'The reason is unknown.';
  const more = failures.length > 1 ? ` (${failures.length - 1} more ${failures.length === 2 ? 'product' : 'products'} failed too)` : '';
  return {
    heading: `${plural(response.failed, 'file')} could not be added to ${failures.length === 1 ? 'a product' : 'products'}`,
    message: `${titleOf(first.itemId)}: ${reason}${more}`,
    hint: PARTIAL_HINT,
  };
}

const MAYBE_DONE_CODES: readonly string[] = ['network_error', 'timeout', 'service_unavailable'];

// The request itself failed. After a lost answer or a timeout the server may have finished the job anyway.
export function attachErrorNotice(error: unknown): AttachNotice {
  const maybeDone = error instanceof ApiError && MAYBE_DONE_CODES.includes(error.code);
  return {
    heading: 'Could not add the outputs to the products',
    message: errorMessage(error, 'Something went wrong. Try again.'),
    hint: maybeDone
      ? 'Some media may have been added already. This page refreshes to show what is on the products.'
      : 'Try again. Products that already have their media are not changed twice.',
  };
}
