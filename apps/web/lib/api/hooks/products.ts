import { useInfiniteQuery } from '@tanstack/react-query';
import { endpoints } from '../endpoints';
import { queryKeys } from '../keys';
import { listableProductPages, tabStatusFilter, type ProductStatusTab } from '../products';

export const PRODUCT_PAGE_SIZE = 25;

// GET /api/v1/products, cursor paged. An empty search lists the whole catalog, and the tab is a server side status
// filter, so every (search, tab) pair has its own pages in the cache. The pages the table has visited stay loaded:
// going back to one costs no request.
export function useProducts(search: string, tab: ProductStatusTab = 'all') {
  const q = search.trim();
  const status = tabStatusFilter(tab);
  return useInfiniteQuery({
    queryKey: queryKeys.products.list(q, tab),
    queryFn: ({ pageParam }) =>
      endpoints.products.list({ q: q === '' ? undefined : q, status, cursor: pageParam, limit: PRODUCT_PAGE_SIZE }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => (last.pageInfo.hasNextPage ? (last.pageInfo.endCursor ?? undefined) : undefined),
    select: listableProductPages,
  });
}
