import type { ProductListItem, ProductListParams, ProductListResponse } from '@rs/shared';
import type { InfiniteData } from '@tanstack/react-query';
import { describe, expect, it, vi } from 'vitest';
import { pageItems } from './pages';
import {
  PRODUCT_STATUS_TABS,
  SELECT_ALL_PAGE_LIMIT,
  fetchAllProducts,
  hasImage,
  listableProductPages,
  listableProducts,
  tabStatusFilter,
  type ListProducts,
} from './products';

function product(id: number, overrides: Partial<ProductListItem> = {}): ProductListItem {
  return {
    id: `gid://shopify/Product/${id}`,
    title: `Product ${id}`,
    handle: `product-${id}`,
    status: 'ACTIVE',
    vendor: '',
    productType: '',
    imageUrl: `https://cdn.example/${id}.jpg`,
    mediaCount: 1,
    variantsCount: 1,
    ...overrides,
  };
}

const ids = (items: readonly ProductListItem[]): number[] =>
  items.map((item) => Number(item.id.slice(item.id.lastIndexOf('/') + 1)));

describe('tabStatusFilter', () => {
  it('sends the status of the Active and Draft tabs and nothing for All', () => {
    expect(tabStatusFilter('active')).toBe('active');
    expect(tabStatusFilter('draft')).toBe('draft');
    expect(tabStatusFilter('all')).toBeUndefined();
    expect(PRODUCT_STATUS_TABS).toEqual(['all', 'active', 'draft']);
  });
});

describe('products without an image', () => {
  it('have no image url, or a blank one, whatever their media count says', () => {
    expect(hasImage(product(1))).toBe(true);
    expect(hasImage(product(1, { imageUrl: null }))).toBe(false);
    expect(hasImage(product(1, { imageUrl: null, mediaCount: 0 }))).toBe(false);
    expect(hasImage(product(1, { imageUrl: null, mediaCount: 3 }))).toBe(false);
    expect(hasImage(product(1, { imageUrl: '  ' }))).toBe(false);
  });

  it('are dropped from a list, keeping the order of the rest', () => {
    const items = [product(1), product(2, { imageUrl: null, mediaCount: 0 }), product(3), product(4, { imageUrl: '' })];
    expect(ids(listableProducts(items))).toEqual([1, 3]);
    expect(listableProducts([])).toEqual([]);
  });

  it('are dropped from every loaded page, leaving cursors and page params alone', () => {
    const data: InfiniteData<ProductListResponse, string | undefined> = {
      pages: [
        { items: [product(1, { imageUrl: null }), product(2)], pageInfo: { endCursor: '2', hasNextPage: true } },
        { items: [product(3, { imageUrl: null })], pageInfo: { endCursor: '3', hasNextPage: true } },
        { items: [product(4)], pageInfo: { endCursor: null, hasNextPage: false } },
      ],
      pageParams: [undefined, '2', '3'],
    };
    const result = listableProductPages(data);
    expect(result.pages.map((page) => ids(page.items))).toEqual([[2], [], [4]]);
    expect(result.pages.map((page) => page.pageInfo)).toEqual(data.pages.map((page) => page.pageInfo));
    expect(result.pageParams).toEqual([undefined, '2', '3']);
    expect(data.pages[0]?.items).toHaveLength(2);
  });
});

describe('pageItems', () => {
  it('flattens loaded pages in order and is empty before the first page', () => {
    const data: InfiniteData<ProductListResponse> = {
      pages: [
        { items: [product(1), product(2)], pageInfo: { endCursor: '2', hasNextPage: true } },
        { items: [product(3)], pageInfo: { endCursor: '3', hasNextPage: false } },
      ],
      pageParams: [undefined, '2'],
    };
    expect(ids(pageItems(data))).toEqual([1, 2, 3]);
    expect(pageItems(undefined)).toEqual([]);
  });
});

// A catalog served in cursor pages of any size, like the real API.
function catalog(items: ProductListItem[]): { list: ListProducts; calls: ProductListParams[] } {
  const calls: ProductListParams[] = [];
  const list: ListProducts = async (params) => {
    calls.push(params);
    const start = params.cursor === undefined ? 0 : Number(params.cursor);
    const size = params.limit ?? 25;
    const page = items.slice(start, start + size);
    const end = start + page.length;
    return { items: page, pageInfo: { endCursor: end < items.length ? String(end) : null, hasNextPage: end < items.length } };
  };
  return { list, calls };
}

describe('fetchAllProducts', () => {
  const many = Array.from({ length: 137 }, (_, index) => product(index + 1));

  it('walks every page of 50 and returns all products in list order', async () => {
    const { list, calls } = catalog(many);
    const result = await fetchAllProducts(list, { q: 'shirt', status: 'draft' });
    expect(ids(result)).toEqual(ids(many));
    expect(calls.map((call) => call.cursor)).toEqual([undefined, '50', '100']);
    expect(calls.every((call) => call.limit === SELECT_ALL_PAGE_LIMIT && call.q === 'shirt' && call.status === 'draft')).toBe(true);
  });

  it('makes one request for a short list and none beyond the last page', async () => {
    const { list, calls } = catalog(many.slice(0, 3));
    expect(await fetchAllProducts(list, {})).toHaveLength(3);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.q).toBeUndefined();
  });

  it('returns an empty list for an empty catalog', async () => {
    const { list } = catalog([]);
    expect(await fetchAllProducts(list, { q: 'zzz' })).toEqual([]);
  });

  it('leaves out products without an image, also from pages that are only imageless', async () => {
    const mixed = Array.from({ length: 120 }, (_, index) =>
      product(index + 1, index >= 50 && index < 100 ? { imageUrl: null, mediaCount: 0 } : {}),
    );
    const { list, calls } = catalog(mixed);
    const result = await fetchAllProducts(list, {});
    expect(result).toHaveLength(70);
    expect(result.every(hasImage)).toBe(true);
    expect(calls).toHaveLength(3);
  });

  it('does not list a product twice when pages overlap', async () => {
    const pages: ProductListResponse[] = [
      { items: [product(1), product(2)], pageInfo: { endCursor: 'a', hasNextPage: true } },
      { items: [product(2), product(3)], pageInfo: { endCursor: null, hasNextPage: false } },
    ];
    const list: ListProducts = vi.fn(async (params) => {
      const page = pages[params.cursor === undefined ? 0 : 1];
      if (page === undefined) throw new Error('no such page');
      return page;
    });
    expect(ids(await fetchAllProducts(list, {}))).toEqual([1, 2, 3]);
  });

  it('stops when the API keeps answering with the same cursor', async () => {
    const list: ListProducts = vi.fn(async () => ({
      items: [product(1)],
      pageInfo: { endCursor: 'same', hasNextPage: true },
    }));
    const result = await fetchAllProducts(list, {});
    expect(ids(result)).toEqual([1]);
    expect(list).toHaveBeenCalledTimes(2);
  });

  it('rejects with the abort reason, without a further request, when aborted between pages', async () => {
    const { list, calls } = catalog(many);
    const controller = new AbortController();
    const slow: ListProducts = async (params) => {
      const response = await list(params);
      controller.abort();
      return response;
    };
    await expect(fetchAllProducts(slow, {}, controller.signal)).rejects.toMatchObject({ name: 'AbortError' });
    expect(calls).toHaveLength(1);
  });

  it('does not start when the signal is already aborted', async () => {
    const { list, calls } = catalog(many);
    const controller = new AbortController();
    controller.abort();
    await expect(fetchAllProducts(list, {}, controller.signal)).rejects.toMatchObject({ name: 'AbortError' });
    expect(calls).toHaveLength(0);
  });

  it('passes a failure of a page on', async () => {
    const list: ListProducts = vi
      .fn<ListProducts>()
      .mockResolvedValueOnce({ items: [product(1)], pageInfo: { endCursor: '1', hasNextPage: true } })
      .mockRejectedValueOnce(new Error('page 2 failed'));
    await expect(fetchAllProducts(list, {})).rejects.toThrow('page 2 failed');
  });
});
