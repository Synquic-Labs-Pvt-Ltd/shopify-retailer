import { useInfiniteQuery } from '@tanstack/react-query';
import { endpoints } from '../endpoints';
import { queryKeys } from '../keys';

export const PRODUCT_PAGE_SIZE = 20;

// The status tabs filter loaded items client side (see filterProductsByStatus), so the cache is not split by tab.
const ALL_STATUSES = 'all';

// GET /api/v1/products, cursor paged. An empty search lists the whole catalog.
export function useProducts(search: string) {
  const q = search.trim();
  return useInfiniteQuery({
    queryKey: queryKeys.products.list(q, ALL_STATUSES),
    queryFn: ({ pageParam }) =>
      endpoints.products.list({ q: q === '' ? undefined : q, cursor: pageParam, limit: PRODUCT_PAGE_SIZE }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => (last.pageInfo.hasNextPage ? (last.pageInfo.endCursor ?? undefined) : undefined),
  });
}
