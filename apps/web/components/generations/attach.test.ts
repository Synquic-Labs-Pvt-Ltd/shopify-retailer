import { ApiError } from '@rs/shared';
import type { AttachMediaResponse, BatchItemView, MediaObject } from '@rs/shared';
import { describe, expect, it } from 'vitest';
import {
  BATCH_ATTACHED_LABEL,
  BATCH_ATTACH_LABEL,
  ITEM_ATTACHED_LABEL,
  ITEM_ATTACH_LABEL,
  attachConfirmText,
  attachErrorNotice,
  attachNotice,
  attachState,
  attachToast,
  attachableItems,
  batchAttachState,
  titleResolver,
} from './attach';

const ATTACHED_AT = '2026-03-10T13:00:00.000Z';

function media(id: number, overrides: Partial<MediaObject> = {}): MediaObject {
  return {
    id: id.toString(16).padStart(24, '0'),
    role: 'output',
    mediaType: 'image',
    status: 'ready',
    url: `https://cdn.shopify.com/s/files/out-${id}.jpg`,
    previewUrl: null,
    width: 1536,
    height: 2048,
    durationSec: null,
    filename: `out-${id}.jpg`,
    scope: null,
    productGid: 'gid://shopify/Product/1',
    shotTitle: null,
    createdAt: `2026-03-10T12:00:0${id}.000Z`,
    ...overrides,
  };
}

const on = (id: number, overrides: Partial<MediaObject> = {}) => media(id, { attachedAt: ATTACHED_AT, ...overrides });

function item(title: string, outputs: MediaObject[], id = 'f'.repeat(24)): BatchItemView {
  return {
    id,
    productGid: 'gid://shopify/Product/1',
    title,
    imageUrl: null,
    status: 'completed',
    referenceMode: 'common_only',
    outputs,
    jobs: [],
  };
}

const ID_A = 'a'.repeat(24);
const ID_B = 'b'.repeat(24);
const ID_C = 'c'.repeat(24);

describe('attachState', () => {
  it('has nothing to add before the first output is ready', () => {
    expect(attachState(item('Lamp', []))).toBe('none');
    expect(attachState(item('Lamp', [media(1, { status: 'processing' }), media(2, { url: null })]))).toBe('none');
  });

  it('can add while a ready output is not on the product', () => {
    expect(attachState(item('Lamp', [media(1)]))).toBe('ready');
    expect(attachState(item('Lamp', [media(1, { attachedAt: null })]))).toBe('ready');
    expect(attachState(item('Lamp', [on(1), media(2)]))).toBe('ready');
  });

  it('is done when every ready output is on the product', () => {
    expect(attachState(item('Lamp', [on(1), on(2)]))).toBe('done');
  });

  it('opens again when more outputs get ready after an add', () => {
    const before = item('Lamp', [on(1), on(2)]);
    expect(attachState(before)).toBe('done');
    expect(attachState(item('Lamp', [...before.outputs, media(3, { mediaType: 'video' })]))).toBe('ready');
  });

  it('ignores outputs that are not ready when it decides', () => {
    expect(attachState(item('Lamp', [on(1), media(2, { status: 'processing' })]))).toBe('done');
  });
});

describe('batch level', () => {
  const ready = item('Ready', [media(1)], ID_A);
  const done = item('Done', [on(2)], ID_B);
  const empty = item('Empty', [], ID_C);

  it('lists the products that have something to add', () => {
    expect(attachableItems({ items: [ready, done, empty] }).map((candidate) => candidate.id)).toEqual([ID_A]);
    expect(attachableItems({ items: [done, empty] })).toEqual([]);
    expect(attachableItems({ items: [] })).toEqual([]);
  });

  it('can add while any product has something to add', () => {
    expect(batchAttachState({ items: [ready, done, empty] })).toBe('ready');
    expect(batchAttachState({ items: [empty, ready] })).toBe('ready');
  });

  it('is done when every product with outputs has them on the product', () => {
    expect(batchAttachState({ items: [done, empty] })).toBe('done');
    expect(batchAttachState({ items: [done] })).toBe('done');
  });

  it('hides the button while no product has an output', () => {
    expect(batchAttachState({ items: [empty] })).toBe('none');
    expect(batchAttachState({ items: [] })).toBe('none');
  });

  it('words the buttons and the confirmation', () => {
    expect(BATCH_ATTACH_LABEL).toBe('Add to products');
    expect(BATCH_ATTACHED_LABEL).toBe('Added to products');
    expect(ITEM_ATTACH_LABEL).toBe('Add to product');
    expect(ITEM_ATTACHED_LABEL).toBe('Added to product');
    expect(attachConfirmText(4)).toBe(
      'This changes 4 products in your store. You can remove the media later from the product page in Shopify.',
    );
    expect(attachConfirmText(1)).toMatch(/^This changes 1 product in your store\./);
  });
});

describe('titleResolver', () => {
  it('finds the title of an item and has a fallback for an unknown one', () => {
    const titleOf = titleResolver({ items: [item('Lamp', [], ID_A), item('Mug', [], ID_B)] });
    expect(titleOf(ID_B)).toBe('Mug');
    expect(titleOf(ID_C)).toBe('the product');
  });
});

describe('results', () => {
  const titleOf = titleResolver({ items: [item('Lamp', [], ID_A), item('Mug', [], ID_B), item('Tote', [], ID_C)] });
  const row = (itemId: string, counts: Partial<AttachMediaResponse['items'][number]> = {}) => ({
    itemId,
    productGid: 'gid://shopify/Product/1',
    attached: 0,
    alreadyAttached: 0,
    failed: 0,
    error: null,
    ...counts,
  });
  const response = (items: AttachMediaResponse['items']): AttachMediaResponse => ({
    items,
    attached: items.reduce((sum, entry) => sum + entry.attached, 0),
    alreadyAttached: items.reduce((sum, entry) => sum + entry.alreadyAttached, 0),
    failed: items.reduce((sum, entry) => sum + entry.failed, 0),
  });

  it('tells what was added to one product', () => {
    expect(attachToast(response([row(ID_A, { attached: 3 })]), titleOf)).toEqual({
      message: 'Added 3 files to Lamp',
      isError: false,
    });
    expect(attachToast(response([row(ID_A, { attached: 1 })]), titleOf).message).toBe('Added 1 file to Lamp');
  });

  it('tells what was on the product already', () => {
    expect(attachToast(response([row(ID_A, { alreadyAttached: 2 })]), titleOf)).toEqual({
      message: '2 files already on the product',
      isError: false,
    });
    expect(attachToast(response([row(ID_A, { attached: 3, alreadyAttached: 2 })]), titleOf).message).toBe(
      'Added 3 files to Lamp, 2 already on the product',
    );
  });

  it('sums up a batch by the products that got files', () => {
    const result = response([
      row(ID_A, { attached: 3 }),
      row(ID_B, { attached: 2, alreadyAttached: 1 }),
      row(ID_C, { alreadyAttached: 4 }),
    ]);
    expect(attachToast(result, titleOf)).toEqual({
      message: 'Added 5 files to 2 products, 5 already on the products',
      isError: false,
    });
    expect(attachToast(response([row(ID_A, { alreadyAttached: 2 }), row(ID_B, { alreadyAttached: 1 })]), titleOf).message).toBe(
      '3 files already on the products',
    );
  });

  it('is an error toast when any file failed', () => {
    const toast = attachToast(response([row(ID_A, { attached: 2 }), row(ID_B, { failed: 3, error: 'Denied' })]), titleOf);
    expect(toast).toEqual({ message: 'Added 2 files to 1 product, 3 could not be added', isError: true });
    expect(attachToast(response([row(ID_A, { failed: 1, error: 'Denied' })]), titleOf)).toEqual({
      message: '1 could not be added',
      isError: true,
    });
  });

  it('says so when there was nothing to add', () => {
    expect(attachToast(response([row(ID_A)]), titleOf)).toEqual({ message: 'No finished outputs to add yet', isError: false });
    expect(attachToast(response([]), titleOf).message).toBe('No finished outputs to add yet');
  });

  it('has no banner when nothing failed', () => {
    expect(attachNotice(response([row(ID_A, { attached: 2 }), row(ID_B, { alreadyAttached: 1 })]), titleOf)).toBeNull();
    expect(attachNotice(response([]), titleOf)).toBeNull();
  });

  it('shows the first reason once, with the product it belongs to and a hint', () => {
    const notice = attachNotice(
      response([
        row(ID_A, { attached: 2 }),
        row(ID_B, { failed: 2, error: 'The app may not edit products' }),
        row(ID_C, { failed: 1, error: 'Another reason' }),
      ]),
      titleOf,
    );
    expect(notice?.heading).toBe('3 files could not be added to products');
    expect(notice?.message).toBe('Mug: The app may not edit products (1 more product failed too)');
    expect(notice?.message).not.toContain('Another reason');
    expect(notice?.hint).toMatch(/keep their new media/);
  });

  it('words one failing product and a failure without a reason', () => {
    const notice = attachNotice(response([row(ID_A, { failed: 1, error: null })]), titleOf);
    expect(notice).toMatchObject({
      heading: '1 file could not be added to a product',
      message: 'Lamp: The reason is unknown.',
    });
    expect(attachNotice(response([row(ID_A, { failed: 1, error: '' })]), titleOf)?.message).toBe('Lamp: The reason is unknown.');
  });
});

describe('attachErrorNotice', () => {
  it('uses the message of the error code', () => {
    const notice = attachErrorNotice(new ApiError(409, 'shop_reauth_required', 'Reconnect'));
    expect(notice.heading).toBe('Could not add the outputs to the products');
    expect(notice.message).toBe('Your store needs to be reconnected. Reopen the app from the Shopify admin.');
    expect(notice.hint).toMatch(/not changed twice/);

    expect(attachErrorNotice(new ApiError(429, 'too_many_requests', 'x', { retryAfterSec: 12 })).message).toBe(
      'Too many requests. Wait 12 seconds and try again.',
    );
  });

  it('warns that a request that timed out or got lost may have gone through', () => {
    for (const code of ['timeout', 'network_error', 'service_unavailable'] as const) {
      const notice = attachErrorNotice(new ApiError(0, code, 'x'));
      expect(notice.hint).toMatch(/may have been added already/);
    }
    expect(attachErrorNotice(new ApiError(0, 'timeout', 'x')).message).toBe('The server took too long to answer. Try again.');
    expect(attachErrorNotice(new ApiError(503, 'service_unavailable', 'x')).message).toMatch(/busy or temporarily down/);
  });

  it('falls back for an error that is not an ApiError', () => {
    expect(attachErrorNotice(new Error('boom')).message).toBe('Something went wrong. Try again.');
  });
});
