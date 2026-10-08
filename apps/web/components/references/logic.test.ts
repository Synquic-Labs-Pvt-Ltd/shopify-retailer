import { describe, expect, it } from 'vitest';
import type { DraftProduct, DraftReference } from '@/lib/state/draftTypes';
import {
  addResultMessage,
  canGenerate,
  deepLinkMessage,
  formatDuration,
  generateHint,
  generateLabel,
  outputsLabel,
  outputTotals,
  parseProductIds,
  participatingRefs,
  processingFailedMessage,
  readyProductsLabel,
  resolutionBadge,
  slotCounts,
  takeNewFiles,
  unresolvedBanner,
} from './logic';

function ref(clientId: string, status: DraftReference['status'] = 'ready'): DraftReference {
  return {
    clientId,
    mediaId: null,
    mediaType: 'image',
    filename: `${clientId}.jpg`,
    mimeType: 'image/jpeg',
    fileSize: 1,
    durationSec: null,
    status,
    progress: 0,
    previewUrl: null,
    error: null,
  };
}

function product(id: number): DraftProduct {
  return { id: `gid://shopify/Product/${id}`, title: `Product ${id}`, imageUrl: null };
}

describe('copy', () => {
  it('words the unresolved banner for one and many products', () => {
    expect(unresolvedBanner(1).heading).toBe('1 product needs a reference.');
    expect(unresolvedBanner(3)).toEqual({
      heading: '3 products need a reference.',
      body: 'Add references to each product, or add common references that apply to every product.',
    });
  });

  it('words the generate button and the ready count', () => {
    expect(generateLabel(1)).toBe('Generate 1 product');
    expect(generateLabel(4)).toBe('Generate 4 products');
    expect(readyProductsLabel(1, 4)).toBe('1 of 4 products');
    expect(readyProductsLabel(1, 1)).toBe('1 of 1 product');
  });

  it('words the processing failure toast', () => {
    expect(processingFailedMessage(1)).toBe('A reference could not be processed.');
    expect(processingFailedMessage(3)).toBe('3 references could not be processed.');
  });
});

describe('outputs', () => {
  it('multiplies the per product settings by the number of products', () => {
    const totals = outputTotals(4, 2, 1);
    expect(totals).toEqual({ images: 8, videos: 4, total: 12 });
    expect(outputsLabel(totals)).toBe('12 (8 images, 4 videos)');
  });

  it('uses the singular for one image or video', () => {
    expect(outputsLabel(outputTotals(1, 1, 1))).toBe('2 (1 image, 1 video)');
  });
});

describe('resolutionBadge', () => {
  it('warns when a product has nothing to generate from', () => {
    expect(resolutionBadge({ mode: 'none', label: 'Needs a reference', unresolved: true }, false)).toEqual({
      label: 'Needs a reference',
      tone: 'warning',
    });
  });

  it('shows the resolution label in info, or neutral for common references only', () => {
    expect(resolutionBadge({ mode: 'own_only', label: '2 references', unresolved: false }, false).tone).toBe('info');
    expect(resolutionBadge({ mode: 'own_plus_common', label: '1 reference + common', unresolved: false }, false).tone).toBe(
      'info',
    );
    expect(resolutionBadge({ mode: 'common_only', label: 'Uses common references', unresolved: false }, false)).toEqual({
      label: 'Uses common references',
      tone: 'neutral',
    });
  });

  it('follows the server when a 422 named the product', () => {
    expect(resolutionBadge({ mode: 'own_only', label: '1 reference', unresolved: false }, true)).toEqual({
      label: 'Needs a reference',
      tone: 'warning',
    });
  });
});

describe('slots', () => {
  const draft = {
    products: [product(1), product(2)],
    commonRefs: [ref('c1', 'ready'), ref('c2', 'processing')],
    productRefs: {
      [product(1).id]: [ref('p1', 'uploading')],
      [product(2).id]: [ref('p2', 'failed')],
      [product(9).id]: [ref('gone', 'failed')],
    },
  };

  it('counts only the slots of the common list and the selected products', () => {
    expect(participatingRefs(draft).map((r) => r.clientId)).toEqual(['c1', 'c2', 'p1', 'p2']);
    expect(slotCounts(draft)).toEqual({ uploading: 1, processing: 1, failed: 1, ready: 1 });
  });

  it('explains what blocks Generate, failures first', () => {
    expect(generateHint({ uploading: 1, processing: 0, failed: 1, ready: 0 })).toBe(
      'Retry or remove the failed reference to continue.',
    );
    expect(generateHint({ uploading: 0, processing: 0, failed: 2, ready: 0 })).toBe(
      'Retry or remove the failed references to continue.',
    );
    expect(generateHint({ uploading: 0, processing: 2, failed: 0, ready: 1 })).toBe('Waiting for uploads to finish.');
    expect(generateHint({ uploading: 0, processing: 0, failed: 0, ready: 3 })).toBeNull();
  });
});

describe('canGenerate', () => {
  const ready = { hydrated: true, submitting: false, productCount: 2, unresolvedCount: 0, slotsReady: true };

  it('needs a hydrated draft, products, no unresolved product and every slot ready', () => {
    expect(canGenerate(ready)).toBe(true);
    expect(canGenerate({ ...ready, hydrated: false })).toBe(false);
    expect(canGenerate({ ...ready, submitting: true })).toBe(false);
    expect(canGenerate({ ...ready, productCount: 0 })).toBe(false);
    expect(canGenerate({ ...ready, unresolvedCount: 1 })).toBe(false);
    expect(canGenerate({ ...ready, slotsReady: false })).toBe(false);
  });
});

describe('formatDuration', () => {
  it('formats seconds as minutes and seconds', () => {
    expect(formatDuration(8)).toBe('0:08');
    expect(formatDuration(8.4)).toBe('0:08');
    expect(formatDuration(75)).toBe('1:15');
    expect(formatDuration(600)).toBe('10:00');
  });

  it('is empty when the length is unknown', () => {
    expect(formatDuration(null)).toBe('');
    expect(formatDuration(Number.NaN)).toBe('');
    expect(formatDuration(-1)).toBe('');
  });
});

describe('takeNewFiles', () => {
  it('returns each File object once', () => {
    const seen = new WeakSet<File>();
    const a = new File(['a'], 'a.jpg');
    const b = new File(['b'], 'b.jpg');
    expect(takeNewFiles([a, b], seen)).toEqual([a, b]);
    expect(takeNewFiles([a, b], seen)).toEqual([]);
    const again = new File(['a'], 'a.jpg');
    expect(takeNewFiles([a, again], seen)).toEqual([again]);
  });
});

describe('addResultMessage', () => {
  const none = { failed: 0, blocked: false };

  it('summarises the problems first', () => {
    expect(addResultMessage({ problems: ['a.heic: Convert it.'], uploads: none })).toBe('a.heic: Convert it.');
    expect(addResultMessage({ problems: ['a: x', 'b: y', 'c: z'], uploads: { failed: 2, blocked: false } })).toBe(
      'a: x (and 2 more problems)',
    );
  });

  it('reports failed uploads when there is no other problem', () => {
    expect(addResultMessage({ problems: [], uploads: { failed: 1, blocked: false } })).toBe(
      'An upload failed. Retry it or remove it.',
    );
    expect(addResultMessage({ problems: [], uploads: { failed: 3, blocked: false } })).toBe(
      '3 uploads failed. Retry them or remove them.',
    );
  });

  it('stays quiet when all went well or the blocked banner explains the failure', () => {
    expect(addResultMessage({ problems: [], uploads: none })).toBeNull();
    expect(addResultMessage({ problems: [], uploads: { failed: 2, blocked: true } })).toBeNull();
  });
});

describe('deepLinkMessage', () => {
  const clean = { invalid: 0, truncated: 0, failed: 0, dropped: 0 };

  it('is null when every product was added', () => {
    expect(deepLinkMessage(clean)).toBeNull();
  });

  it('counts invalid ids and failed fetches as products that could not be added', () => {
    expect(deepLinkMessage({ ...clean, invalid: 1, failed: 2 })).toBe('3 products could not be added.');
    expect(deepLinkMessage({ ...clean, failed: 1 })).toBe('1 product could not be added.');
  });

  it('mentions the batch limit when products were cut', () => {
    expect(deepLinkMessage({ ...clean, truncated: 1 })).toBe('1 product was left out because of the batch limit.');
    expect(deepLinkMessage({ ...clean, failed: 1, dropped: 2 })).toBe(
      '1 product could not be added. 2 products were left out because of the batch limit.',
    );
  });
});

describe('parseProductIds', () => {
  const gid = (n: number) => `gid://shopify/Product/${n}`;

  it('reads comma separated product GIDs', () => {
    expect(parseProductIds(`${gid(1)},${gid(2)}`, 50)).toEqual({ ids: [gid(1), gid(2)], invalid: 0, truncated: 0 });
  });

  it('trims, ignores empty parts and drops duplicates', () => {
    expect(parseProductIds(` ${gid(1)} ,, ${gid(1)},${gid(2)},`, 50).ids).toEqual([gid(1), gid(2)]);
  });

  it('counts values that are not Shopify product GIDs', () => {
    const parsed = parseProductIds(`${gid(1)},123,gid://shopify/Collection/5,nope`, 50);
    expect(parsed).toEqual({ ids: [gid(1)], invalid: 3, truncated: 0 });
  });

  it('cuts the list at the batch cap', () => {
    const parsed = parseProductIds([1, 2, 3, 4].map(gid).join(','), 3);
    expect(parsed.ids).toEqual([gid(1), gid(2), gid(3)]);
    expect(parsed.truncated).toBe(1);
  });

  it('returns nothing for a missing or empty value', () => {
    expect(parseProductIds(null, 50)).toEqual({ ids: [], invalid: 0, truncated: 0 });
    expect(parseProductIds(undefined, 50).ids).toEqual([]);
    expect(parseProductIds('', 50).ids).toEqual([]);
  });
});
