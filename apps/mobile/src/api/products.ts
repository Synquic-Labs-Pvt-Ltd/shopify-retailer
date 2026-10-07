import { useInfiniteQuery } from '@tanstack/react-query';
import { api } from './client';
import { queryKeys } from './keys';

const PAGE_SIZE = 20;

// GET /api/v1/products, cursor paged. An empty search lists the whole catalog.
export function useProducts(search: string) {
  const q = search.trim();
  return useInfiniteQuery({
    queryKey: queryKeys.products.list(q),
    queryFn: ({ pageParam }) =>
      api.products.list({ q: q === '' ? undefined : q, cursor: pageParam, limit: PAGE_SIZE }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => (last.pageInfo.hasNextPage ? (last.pageInfo.endCursor ?? undefined) : undefined),
  });
}
