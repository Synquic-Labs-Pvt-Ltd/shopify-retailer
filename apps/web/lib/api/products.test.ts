import type { ProductListItem, ProductListResponse, ProductStatus } from '@rs/shared';
import type { InfiniteData } from '@tanstack/react-query';
import { describe, expect, it } from 'vitest';
import { pageItems } from './pages';
import { filterProductsByStatus } from './products';

function product(id: number, status: ProductStatus): ProductListItem {
  return {
    id: `gid://shopify/Product/${id}`,
    title: `Product ${id}`,
    handle: `product-${id}`,
    status,
    vendor: '',
    productType: '',
    imageUrl: null,
    mediaCount: 0,
    variantsCount: 1,
  };
}

const ITEMS = [
  product(1, 'ACTIVE'),
  product(2, 'DRAFT'),
  product(3, 'ARCHIVED'),
  product(4, 'ACTIVE'),
  product(5, 'UNLISTED'),
  product(6, 'DRAFT'),
];

describe('filterProductsByStatus', () => {
  it('keeps every status, in order, for All', () => {
    expect(filterProductsByStatus(ITEMS, 'all')).toEqual(ITEMS);
  });

  it('returns a copy for All so callers can sort it', () => {
    expect(filterProductsByStatus(ITEMS, 'all')).not.toBe(ITEMS);
  });

  it('keeps only ACTIVE for Active', () => {
    expect(filterProductsByStatus(ITEMS, 'active').map((item) => item.id)).toEqual([
      'gid://shopify/Product/1',
      'gid://shopify/Product/4',
    ]);
  });

  it('keeps only DRAFT for Draft', () => {
    expect(filterProductsByStatus(ITEMS, 'draft').map((item) => item.id)).toEqual([
      'gid://shopify/Product/2',
      'gid://shopify/Product/6',
    ]);
  });

  it('handles an empty list', () => {
    expect(filterProductsByStatus([], 'active')).toEqual([]);
  });
});

describe('pageItems', () => {
  it('flattens loaded pages in order and is empty before the first page', () => {
    const data: InfiniteData<ProductListResponse> = {
      pages: [
        { items: ITEMS.slice(0, 2), pageInfo: { endCursor: '2', hasNextPage: true } },
        { items: ITEMS.slice(2, 3), pageInfo: { endCursor: '3', hasNextPage: false } },
      ],
      pageParams: [undefined, '2'],
    };
    expect(pageItems(data).map((item) => item.id)).toEqual(ITEMS.slice(0, 3).map((item) => item.id));
    expect(pageItems(undefined)).toEqual([]);
  });
});
