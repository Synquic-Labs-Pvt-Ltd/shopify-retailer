import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { isTerminalBatchStatus, type BatchListResponse, type BatchStatus, type CreateBatchInput } from '@rs/shared';
import { endpoints } from '../endpoints';
import { queryKeys } from '../keys';
import { useDocumentVisible } from './visibility';

export const BATCH_PAGE_SIZE = 20;
export const BATCH_LIST_POLL_MS = 8_000;
export const BATCH_DETAIL_POLL_MS = 4_000;

// Polls every 8 s while any loaded batch is non-terminal and the tab is visible.
export function batchListPollInterval(pages: readonly BatchListResponse[] | undefined, visible: boolean): number | false {
  const active = pages?.some((page) => page.items.some((batch) => !isTerminalBatchStatus(batch.status))) ?? false;
  return visible && active ? BATCH_LIST_POLL_MS : false;
}

interface BatchDetailPollState {
  // Status of the loaded batch, undefined before the first response.
  status: BatchStatus | undefined;
  hasError: boolean;
}

// Polls every 4 s until the batch is terminal. A first load that fails stops the timer.
export function batchDetailPollInterval({ status, hasError }: BatchDetailPollState, visible: boolean): number | false {
  if (!visible) return false;
  if (status === undefined) return hasError ? false : BATCH_DETAIL_POLL_MS;
  return isTerminalBatchStatus(status) ? false : BATCH_DETAIL_POLL_MS;
}

// GET /api/v1/batches, cursor paged.
export function useBatches() {
  const visible = useDocumentVisible();
  return useInfiniteQuery({
    queryKey: queryKeys.batches.list(),
    queryFn: ({ pageParam }) => endpoints.batches.list({ cursor: pageParam, limit: BATCH_PAGE_SIZE }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => (last.pageInfo.hasNextPage ? (last.pageInfo.endCursor ?? undefined) : undefined),
    refetchInterval: (query) => batchListPollInterval(query.state.data?.pages, visible),
  });
}

// GET /api/v1/batches/:id
export function useBatch(id: string) {
  const visible = useDocumentVisible();
  return useQuery({
    queryKey: queryKeys.batches.detail(id),
    queryFn: () => endpoints.batches.get(id),
    enabled: id !== '',
    staleTime: 0,
    refetchInterval: (query) =>
      batchDetailPollInterval({ status: query.state.data?.status, hasError: query.state.error !== null }, visible),
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
    mutationFn: (body: CreateBatchInput) => endpoints.batches.create(body),
    onSuccess: refresh,
  });
}

export function useCancelBatch() {
  const refresh = useRefreshBatches();
  return useMutation({ mutationFn: (id: string) => endpoints.batches.cancel(id), onSuccess: refresh });
}

export function useRetryFailed() {
  const refresh = useRefreshBatches();
  return useMutation({ mutationFn: (id: string) => endpoints.batches.retryFailed(id), onSuccess: refresh });
}
