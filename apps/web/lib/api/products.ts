import type { ProductListItem, ProductListParams, ProductListQuery, ProductListResponse } from '@rs/shared';
import type { InfiniteData } from '@tanstack/react-query';

// The Active and Draft tabs are a server side filter (`status` of GET /api/v1/products), so pages and counts stay
// consistent. "All" sends no status and keeps every status, including archived and unlisted products.
export const PRODUCT_STATUS_TABS = ['all', 'active', 'draft'] as const;
export type ProductStatusTab = (typeof PRODUCT_STATUS_TABS)[number];

export function tabStatusFilter(tab: ProductStatusTab): ProductListQuery['status'] | undefined {
  return tab === 'all' ? undefined : tab;
}

// A product without an image can neither be listed nor selected: the featured image is the ground truth every
// generation starts from. The backend leaves such products out already; this is the defensive client side of the
// rule. A missing or blank image url means no image, whatever mediaCount says.
export function hasImage(item: Pick<ProductListItem, 'imageUrl'>): boolean {
  return item.imageUrl !== null && item.imageUrl.trim() !== '';
}

export function listableProducts<T extends Pick<ProductListItem, 'imageUrl'>>(items: readonly T[]): T[] {
  return items.filter(hasImage);
}

type ProductPages = InfiniteData<ProductListResponse, string | undefined>;

// The `select` of the products query: the loaded pages without their imageless products. A page can end up with
// fewer rows than the page size, or none; the cursors are untouched.
export function listableProductPages(data: ProductPages): ProductPages {
  return { ...data, pages: data.pages.map((page) => ({ ...page, items: listableProducts(page.items) })) };
}

// Largest page the API serves.
export const SELECT_ALL_PAGE_LIMIT = 50;

export type ListProducts = (params: ProductListParams) => Promise<ProductListResponse>;

// Every listable product that matches the filter, across all pages, in list order. Pages are fetched one after the
// other until the API reports no next page (or stops advancing its cursor). `list` serves requests that cannot
// be cancelled, so an abort is noticed between pages: the call then rejects with the signal's reason and nothing
// the pending page returns is used.
export async function fetchAllProducts(
  list: ListProducts,
  filter: Pick<ProductListParams, 'q' | 'status'>,
  signal?: AbortSignal,
): Promise<ProductListItem[]> {
  const found = new Map<string, ProductListItem>();
  let cursor: string | undefined;
  for (;;) {
    signal?.throwIfAborted();
    const page = await list({ q: filter.q, status: filter.status, cursor, limit: SELECT_ALL_PAGE_LIMIT });
    signal?.throwIfAborted();
    for (const item of listableProducts(page.items)) found.set(item.id, item);
    const { hasNextPage, endCursor } = page.pageInfo;
    if (!hasNextPage || endCursor === null || endCursor === cursor) return [...found.values()];
    cursor = endCursor;
  }
}
