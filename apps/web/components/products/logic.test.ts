import type { ProductListItem, ProductStatus } from '@rs/shared';
import { describe, expect, it } from 'vitest';
import {
  checkState,
  deselectListed,
  emptyCopy,
  limitMessage,
  selectedLabel,
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
    imageUrl: id % 2 === 0 ? `https://cdn.example/${id}.jpg` : null,
    mediaCount: 1,
    variantsCount: 1,
  };
}

const LISTED = [1, 2, 3, 4].map((id) => product(id));

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
});

describe('selectListed', () => {
  it('adds the listed products that are not selected, after the existing ones', () => {
    const current = [toDraftProduct(product(2))];
    const result = selectListed(current, LISTED, 50);
    expect(result.products.map((p) => p.title)).toEqual(['Product 2', 'Product 1', 'Product 3', 'Product 4']);
    expect(result.truncated).toBe(0);
  });

  it('stops at the cap and reports how many were left out', () => {
    const current = [toDraftProduct(product(1))];
    const result = selectListed(current, LISTED, 3);
    expect(result.products).toHaveLength(3);
    expect(result.truncated).toBe(1);
  });

  it('adds nothing when the selection is already full', () => {
    const current = LISTED.slice(0, 2).map(toDraftProduct);
    const result = selectListed(current, [product(7), product(8)], 2);
    expect(result.products).toEqual(current);
    expect(result.truncated).toBe(2);
  });
});

describe('deselectListed', () => {
  it('removes the listed products and keeps those selected elsewhere', () => {
    const current = [1, 2, 9].map((id) => toDraftProduct(product(id)));
    expect(deselectListed(current, LISTED).map((p) => p.id)).toEqual(['gid://shopify/Product/9']);
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
    expect(limitMessage(50)).toBe('You can select up to 50 products.');
    expect(truncatedMessage(50)).toBe('Selection is limited to 50 products.');
  });

  it('changes the empty state with the search and the tab', () => {
    expect(emptyCopy({ searching: false, tab: 'all', hasMore: false }).heading).toBe('No products yet');
    expect(emptyCopy({ searching: true, tab: 'all', hasMore: false }).heading).toBe('No products found');
    expect(emptyCopy({ searching: false, tab: 'draft', hasMore: true })).toEqual({
      heading: 'No draft products loaded yet',
      body: 'Load more products to keep looking.',
    });
    expect(emptyCopy({ searching: true, tab: 'active', hasMore: false })).toEqual({
      heading: 'No active products',
      body: 'Try a different search.',
    });
  });
});
