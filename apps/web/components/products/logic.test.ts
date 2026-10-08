import type { ProductListItem, ProductStatus } from '@rs/shared';
import { describe, expect, it } from 'vitest';
import {
  applySelectAll,
  busyLabel,
  checkState,
  deselectListed,
  emptyCopy,
  limitMessage,
  matchSummary,
  productFilterKey,
  selectAllMessage,
  selectedLabel,
  selectionDetail,
  selectListed,
  statusBadge,
  toDraftProduct,
  truncatedMessage,
} from './logic';

function product(id: number, status: ProductStatus = 'ACTIVE'): ProductListItem {
  return {
    id: `gid://shopify/Product/${id}`,
    title: `Product ${id}`,
    handle: `product-${id}`,
    status,
    vendor: 'Vendor',
    productType: '',
    imageUrl: `https://cdn.example/${id}.jpg`,
    mediaCount: 1,
    variantsCount: 1,
  };
}

const LISTED = [1, 2, 3, 4].map((id) => product(id));
const CAPPED = 'Selected the first 50 of 137 products — a batch can hold at most 50.';

describe('toDraftProduct', () => {
  it('keeps only what the draft stores', () => {
    expect(toDraftProduct(product(2))).toEqual({
      id: 'gid://shopify/Product/2',
      title: 'Product 2',
      imageUrl: 'https://cdn.example/2.jpg',
    });
  });
});

describe('checkState', () => {
  const ids = (...numbers: number[]) => new Set(numbers.map((n) => `gid://shopify/Product/${n}`));

  it('is none for an empty list or no selected product on it', () => {
    expect(checkState([], ids(1))).toBe('none');
    expect(checkState(LISTED, ids(9))).toBe('none');
  });

  it('is some when part of the list is selected and all when every listed product is', () => {
    expect(checkState(LISTED, ids(1, 9))).toBe('some');
    expect(checkState(LISTED, ids(1, 2, 3, 4, 9))).toBe('all');
  });

  it('follows the whole result, not the page, once the whole result is known', () => {
    const everything = [1, 2, 3, 4, 5, 6].map((id) => product(id));
    const thisPage = everything.slice(0, 2);
    // Only the first page is selected: the page says all, the whole result says some.
    expect(checkState(thisPage, ids(1, 2))).toBe('all');
    expect(checkState(everything, ids(1, 2))).toBe('some');
    expect(checkState(everything, ids(1, 2, 3, 4, 5, 6))).toBe('all');
    // A page of a fully selected result looks the same as any other.
    expect(checkState(everything.slice(2, 4), ids(1, 2, 3, 4, 5, 6))).toBe('all');
  });
});

describe('selectListed', () => {
  it('adds the listed products that are not selected, after the existing ones', () => {
    const current = [toDraftProduct(product(2))];
    const result = selectListed(current, LISTED, 50);
    expect(result.products.map((p) => p.title)).toEqual(['Product 2', 'Product 1', 'Product 3', 'Product 4']);
    expect(result.truncated).toBe(0);
    expect(result.selected).toBe(4);
    expect(result.total).toBe(4);
  });

  it('stops at the cap and reports how many were left out and how many of the list are selected', () => {
    const current = [toDraftProduct(product(1))];
    const result = selectListed(current, LISTED, 3);
    expect(result.products).toHaveLength(3);
    expect(result.truncated).toBe(1);
    expect(result.selected).toBe(3);
    expect(result.total).toBe(4);
  });

  it('adds nothing when the selection is already full', () => {
    const current = LISTED.slice(0, 2).map(toDraftProduct);
    const result = selectListed(current, [product(7), product(8)], 2);
    expect(result.products).toEqual(current);
    expect(result.truncated).toBe(2);
    expect(result.selected).toBe(0);
    expect(result.total).toBe(2);
  });

  it('counts products selected elsewhere against the cap but not against the list', () => {
    const current = [9, 10, 11].map((id) => toDraftProduct(product(id)));
    const result = selectListed(current, LISTED, 5);
    expect(result.products).toHaveLength(5);
    expect(result.selected).toBe(2);
    expect(result.truncated).toBe(2);
  });

  it('selects a whole result up to the cap, and the first products of a larger one', () => {
    const many = Array.from({ length: 137 }, (_, index) => product(index + 1));
    const capped = selectListed([], many, 50);
    expect(capped.products.map((p) => p.id)).toEqual(many.slice(0, 50).map((item) => item.id));
    expect([capped.selected, capped.total, capped.truncated]).toEqual([50, 137, 87]);

    const all = selectListed([], many.slice(0, 30), 50);
    expect([all.selected, all.total, all.truncated]).toEqual([30, 30, 0]);
  });
});

describe('deselectListed', () => {
  it('removes the listed products and keeps those selected elsewhere', () => {
    const current = [1, 2, 9].map((id) => toDraftProduct(product(id)));
    expect(deselectListed(current, LISTED).map((p) => p.id)).toEqual(['gid://shopify/Product/9']);
  });
});

describe('select-all messages', () => {
  it('says exactly how many were selected of how many when the cap cuts a select-all', () => {
    expect(truncatedMessage(50, 50, 137)).toBe(CAPPED);
    expect(truncatedMessage(50, 12, 60)).toBe('Selected the first 12 of 60 products — a batch can hold at most 50.');
  });

  it('falls back to the plain limit when nothing could be added', () => {
    expect(truncatedMessage(50, 0, 137)).toBe('You can select up to 50 products.');
  });

  it('has a message only when something was left out', () => {
    expect(selectAllMessage({ truncated: 0, selected: 30, total: 30 }, 50)).toBeNull();
    expect(selectAllMessage({ truncated: 87, selected: 50, total: 137 }, 50)).toBe(CAPPED);
  });
});

describe('applySelectAll', () => {
  const many = Array.from({ length: 137 }, (_, index) => product(index + 1));

  it('selects the first 50 of 137 and tells so', () => {
    const { products, message } = applySelectAll('select', [], many, 50);
    expect(products).toHaveLength(50);
    expect(message).toBe(CAPPED);
  });

  it('selects everything without a message when it fits', () => {
    const { products, message } = applySelectAll('select', [], many.slice(0, 40), 50);
    expect(products).toHaveLength(40);
    expect(message).toBeNull();
  });

  it('deselects every product of the result and keeps the ones selected elsewhere', () => {
    const current = [...many.slice(0, 50), product(500), product(501)].map(toDraftProduct);
    const { products, message } = applySelectAll('deselect', current, many, 50);
    expect(products.map((p) => p.id)).toEqual([product(500).id, product(501).id]);
    expect(message).toBeNull();
  });

  it('does not change the selection for an empty result', () => {
    const current = [toDraftProduct(product(1))];
    expect(applySelectAll('select', current, [], 50)).toEqual({ products: current, message: null });
    expect(applySelectAll('deselect', current, [], 50)).toEqual({ products: current, message: null });
  });
});

describe('selection summary', () => {
  const ids = (...numbers: number[]) => new Set(numbers.map((n) => `gid://shopify/Product/${n}`));

  it('counts how much of the whole result is selected', () => {
    expect(matchSummary(LISTED, ids(1, 2, 9))).toEqual({ selected: 2, total: 4 });
    expect(matchSummary([], ids(1))).toEqual({ selected: 0, total: 0 });
  });

  it('says all of them are selected when the whole result is', () => {
    expect(selectionDetail({ selected: 137, total: 137 })).toBe('All 137 products selected');
    expect(selectionDetail({ selected: 1, total: 1 })).toBe('All 1 product selected');
  });

  it('says N of M when only part of the result is selected, as after the cap stopped a select-all', () => {
    expect(selectionDetail({ selected: 50, total: 137 })).toBe('50 of 137 selected');
  });

  it('says nothing while the result is unknown or none of it is selected', () => {
    expect(selectionDetail(null)).toBeNull();
    expect(selectionDetail({ selected: 0, total: 137 })).toBeNull();
    expect(selectionDetail({ selected: 0, total: 0 })).toBeNull();
  });
});

describe('select-all progress', () => {
  it('labels the fetch of every page', () => {
    expect(busyLabel('select')).toBe('Selecting products...');
    expect(busyLabel('deselect')).toBe('Deselecting products...');
  });

  it('keys a select-all by search and tab, ignoring the spaces around the search', () => {
    expect(productFilterKey('lamp', 'draft')).toBe(productFilterKey('  lamp ', 'draft'));
    expect(productFilterKey('lamp', 'draft')).not.toBe(productFilterKey('lamp', 'active'));
    expect(productFilterKey('lamp', 'all')).not.toBe(productFilterKey('mug', 'all'));
    expect(productFilterKey('', 'all')).not.toBe(productFilterKey('', 'draft'));
  });
});

describe('statusBadge', () => {
  it('maps the statuses to a label and tone', () => {
    expect(statusBadge('ACTIVE')).toEqual({ label: 'Active', tone: 'success' });
    expect(statusBadge('DRAFT')).toEqual({ label: 'Draft', tone: 'info' });
    expect(statusBadge('ARCHIVED').tone).toBe('neutral');
    expect(statusBadge('UNLISTED').label).toBe('Unlisted');
  });
});

describe('copy', () => {
  it('words the selection messages', () => {
    expect(selectedLabel(3)).toBe('3 selected');
    expect(selectedLabel(137)).toBe('137 selected');
    expect(limitMessage(50)).toBe('You can select up to 50 products.');
  });

  it('changes the empty state with the search and the tab', () => {
    const base = { hasMore: false, hasPrevious: false };
    expect(emptyCopy({ ...base, searching: false, tab: 'all' }).heading).toBe('No products yet');
    expect(emptyCopy({ ...base, searching: true, tab: 'all' }).heading).toBe('No products found');
    expect(emptyCopy({ ...base, searching: true, tab: 'active' })).toEqual({
      heading: 'No active products',
      body: 'Try a different search.',
    });
    expect(emptyCopy({ ...base, searching: false, tab: 'draft' })).toEqual({
      heading: 'No draft products',
      body: 'Switch to All to see every product.',
    });
  });

  it('tells to move on when an empty page is followed by another, and never to load more', () => {
    for (const tab of ['all', 'draft'] as const) {
      const copy = emptyCopy({ searching: false, tab, hasMore: true, hasPrevious: false });
      expect(copy.heading).toBe('No products to show on this page');
      expect(copy.body).toBe('Products without an image are hidden. Go to the next page to keep looking.');
      expect(copy.body).not.toMatch(/load more/i);
    }
  });

  it('tells to go back when an empty last page follows others', () => {
    expect(emptyCopy({ searching: true, tab: 'all', hasMore: false, hasPrevious: true })).toEqual({
      heading: 'No more products to show',
      body: 'Products without an image are hidden. Go back to the previous page.',
    });
    // The next page wins when both exist.
    expect(emptyCopy({ searching: false, tab: 'all', hasMore: true, hasPrevious: true }).heading).toBe(
      'No products to show on this page',
    );
  });
});
