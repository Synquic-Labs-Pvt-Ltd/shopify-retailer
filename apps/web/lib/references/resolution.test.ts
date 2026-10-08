import { describe, expect, it } from 'vitest';
import type { DraftProduct, DraftReference } from '@/lib/state/draftTypes';
import {
  allSlotsReady,
  buildBatchRequest,
  mergeUnresolved,
  resolutionLabel,
  resolveProducts,
  unresolvedMessage,
  unresolvedProductIds,
} from './resolution';
import { slot } from './testkit';

const p1: DraftProduct = { id: 'gid://shopify/Product/1', title: 'One', imageUrl: null };
const p2: DraftProduct = { id: 'gid://shopify/Product/2', title: 'Two', imageUrl: null };
const p3: DraftProduct = { id: 'gid://shopify/Product/3', title: 'Three', imageUrl: null };

const ready = (id: string, mediaId: string): DraftReference => slot(id, { status: 'ready', mediaId, progress: 1 });

describe('resolutionLabel', () => {
  it('words each mode', () => {
    expect(resolutionLabel('own_plus_common', 2)).toBe('2 references + common');
    expect(resolutionLabel('own_plus_common', 1)).toBe('1 reference + common');
    expect(resolutionLabel('own_only', 3)).toBe('3 references');
    expect(resolutionLabel('own_only', 1)).toBe('1 reference');
    expect(resolutionLabel('common_only', 0)).toBe('Uses common references');
    expect(resolutionLabel('none', 0)).toBe('Needs a reference');
  });
});

describe('unresolvedMessage', () => {
  it('uses the singular and the plural', () => {
    expect(unresolvedMessage(1)).toBe(
      '1 product needs a reference. Add references to each product or add a common reference.',
    );
    expect(unresolvedMessage(3)).toBe(
      '3 products need a reference. Add references to each product or add a common reference.',
    );
  });
});

describe('resolveProducts', () => {
  it('resolves each product against its own and the common references', () => {
    const draft = {
      products: [p1, p2, p3],
      commonRefs: [ready('c1', 'mc1')],
      productRefs: { [p1.id]: [ready('a', 'm1')] },
    };
    const resolutions = resolveProducts(draft);
    expect(resolutions.map((r) => [r.product.id, r.mode, r.label, r.unresolved])).toEqual([
      [p1.id, 'own_plus_common', '1 reference + common', false],
      [p2.id, 'common_only', 'Uses common references', false],
      [p3.id, 'common_only', 'Uses common references', false],
    ]);
    expect(unresolvedProductIds(draft)).toEqual([]);
  });

  it('flags products without any reference when there are no common ones', () => {
    const draft = { products: [p1, p2], commonRefs: [], productRefs: { [p1.id]: [ready('a', 'm1')] } };
    expect(resolveProducts(draft).map((r) => r.mode)).toEqual(['own_only', 'none']);
    expect(unresolvedProductIds(draft)).toEqual([p2.id]);
  });
});

describe('mergeUnresolved', () => {
  it('unites the local and the server list without duplicates', () => {
    const merged = mergeUnresolved([p2.id, p3.id], [p1.id, p2.id]);
    expect([...merged].sort()).toEqual([p1.id, p2.id, p3.id].sort());
    expect(merged.size).toBe(3);
    expect(mergeUnresolved([], []).size).toBe(0);
  });
});

describe('allSlotsReady', () => {
  it('needs every common slot and every slot of a selected product to be ready', () => {
    const base = { products: [p1], commonRefs: [ready('c1', 'mc1')], productRefs: { [p1.id]: [ready('a', 'm1')] } };
    expect(allSlotsReady(base)).toBe(true);
    expect(allSlotsReady({ ...base, commonRefs: [slot('c2', { status: 'processing' })] })).toBe(false);
    expect(allSlotsReady({ ...base, productRefs: { [p1.id]: [slot('a', { status: 'failed' })] } })).toBe(false);
  });

  it('ignores slots of products that are not selected', () => {
    const draft = {
      products: [p1],
      commonRefs: [],
      productRefs: { [p1.id]: [ready('a', 'm1')], [p2.id]: [slot('b', { status: 'uploading' })] },
    };
    expect(allSlotsReady(draft)).toBe(true);
  });
});

describe('buildBatchRequest', () => {
  it('uses the idempotency key and sends only the ready media ids', () => {
    const request = buildBatchRequest({
      idempotencyKey: 'key-1',
      products: [p1, p2, p3],
      commonRefs: [ready('c1', 'mc1'), slot('c2', { status: 'failed', mediaId: 'mc2' })],
      productRefs: {
        [p1.id]: [ready('a', 'm1'), ready('b', 'm2'), slot('c', { status: 'processing', mediaId: 'm3' })],
        [p2.id]: [],
        [p3.id]: [ready('d', 'm4')],
        'gid://shopify/Product/99': [ready('e', 'm5')],
      },
    });
    expect(request).toEqual({
      idempotencyKey: 'key-1',
      products: [
        { productGid: p1.id, referenceMediaIds: ['m1', 'm2'] },
        { productGid: p2.id, referenceMediaIds: [] },
        { productGid: p3.id, referenceMediaIds: ['m4'] },
      ],
      commonReferenceMediaIds: ['mc1'],
    });
  });
});
