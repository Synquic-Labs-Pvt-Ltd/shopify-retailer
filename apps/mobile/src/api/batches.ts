import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { isTerminalBatchStatus, type BatchListResponse, type CreateBatchInput } from '@rs/shared';
import { api } from './client';
import { queryKeys } from './keys';

const PAGE_SIZE = 20;
export const BATCH_LIST_POLL_MS = 8_000;
export const BATCH_DETAIL_POLL_MS = 4_000;

function hasActiveBatch(pages: BatchListResponse[] | undefined): boolean {
  return pages?.some((page) => page.items.some((batch) => !isTerminalBatchStatus(batch.status))) ?? false;
}

// GET /api/v1/batches, cursor paged. Polls every 8 s while any loaded batch is non-terminal.
// poll=false (an unfocused tab) stops the timer.
export function useBatches(poll: boolean = true) {
  return useInfiniteQuery({
    queryKey: queryKeys.batches.list(),
    queryFn: ({ pageParam }) => api.batches.list({ cursor: pageParam, limit: PAGE_SIZE }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => (last.pageInfo.hasNextPage ? (last.pageInfo.endCursor ?? undefined) : undefined),
    refetchInterval: (query) => (poll && hasActiveBatch(query.state.data?.pages) ? BATCH_LIST_POLL_MS : false),
  });
}

// GET /api/v1/batches/:id. Polls every 4 s until the batch is terminal.
export function useBatch(id: string, poll: boolean = true) {
  return useQuery({
    queryKey: queryKeys.batches.detail(id),
    queryFn: () => api.batches.get(id),
    staleTime: 0,
    refetchInterval: (query) => {
      const status = query.state.data?.status;
      if (!poll || (status === undefined && query.state.error !== null)) return false;
      return status === undefined || !isTerminalBatchStatus(status) ? BATCH_DETAIL_POLL_MS : false;
    },
  });
}

function useRefreshBatches() {
  const queryClient = useQueryClient();
  return () => queryClient.invalidateQueries({ queryKey: queryKeys.batches.all });
}

// POST /api/v1/batches. The idempotency key lives in the draft, so a retry returns the same batch.
export function useCreateBatch() {
  const refresh = useRefreshBatches();
  return useMutation({
    mutationFn: (body: CreateBatchInput) => api.batches.create(body),
    onSuccess: refresh,
  });
}

export function useCancelBatch() {
  const refresh = useRefreshBatches();
  return useMutation({ mutationFn: (id: string) => api.batches.cancel(id), onSuccess: refresh });
}

export function useRetryFailed() {
  const refresh = useRefreshBatches();
  return useMutation({ mutationFn: (id: string) => api.batches.retryFailed(id), onSuccess: refresh });
}
