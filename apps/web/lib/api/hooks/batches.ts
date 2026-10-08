import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { isTerminalBatchStatus, type BatchListResponse, type BatchStatus, type CreateBatchInput } from '@rs/shared';
import { endpoints } from '../endpoints';
import { queryKeys } from '../keys';
import { isTransientError } from '../retry';
import { useDocumentVisible } from './visibility';

export const BATCH_PAGE_SIZE = 20;
export const BATCH_LIST_POLL_MS = 8_000;
export const BATCH_DETAIL_POLL_MS = 4_000;

const hasFailed = (error: unknown): boolean => error !== null && error !== undefined;

// A failed poll keeps the data of the last good one on screen. Polling goes on while the failure is one a later poll
// may get past (network, timeout, outage, rate limit) and stops for the rest (401, 404...), which would only repeat.
const pollsOnAfter = (error: unknown): boolean => !hasFailed(error) || isTransientError(error);

// Polls every 8 s while any loaded batch is non-terminal and the tab is visible. `error` is the failure of the last
// poll, if any.
export function batchListPollInterval(
  pages: readonly BatchListResponse[] | undefined,
  visible: boolean,
  error?: unknown,
): number | false {
  const active = pages?.some((page) => page.items.some((batch) => !isTerminalBatchStatus(batch.status))) ?? false;
  return visible && active && pollsOnAfter(error) ? BATCH_LIST_POLL_MS : false;
}

interface BatchDetailPollState {
  // Status of the loaded batch, undefined before the first response.
  status: BatchStatus | undefined;
  // The failure of the last request, null or undefined when it worked.
  error?: unknown;
}

// Polls every 4 s until the batch is terminal. A first load that fails stops the timer.
export function batchDetailPollInterval({ status, error }: BatchDetailPollState, visible: boolean): number | false {
  if (!visible) return false;
  if (status === undefined) return hasFailed(error) ? false : BATCH_DETAIL_POLL_MS;
  if (isTerminalBatchStatus(status)) return false;
  return pollsOnAfter(error) ? BATCH_DETAIL_POLL_MS : false;
}

// What to tell the viewer about a polled query that already has data on screen:
//  - reconnecting: the last poll failed (or is being retried) for a reason that may pass; polling goes on;
//  - stopped: the failure will not pass by itself, so polling stopped and the data may be out of date;
//  - none: all is well, or nothing is loaded yet (the page then shows its own load error).
export type PollNotice = 'none' | 'reconnecting' | 'stopped';

interface PollHealth {
  hasData: boolean;
  // The failure of the last request, and the failure of the attempt being retried right now.
  error: unknown;
  failureReason?: unknown;
}

export function pollNotice({ hasData, error, failureReason }: PollHealth): PollNotice {
  const problem = hasFailed(error) ? error : failureReason;
  if (!hasData || !hasFailed(problem)) return 'none';
  return isTransientError(problem) ? 'reconnecting' : 'stopped';
}

// GET /api/v1/batches, cursor paged.
export function useBatches() {
  const visible = useDocumentVisible();
  return useInfiniteQuery({
    queryKey: queryKeys.batches.list(),
    queryFn: ({ pageParam }) => endpoints.batches.list({ cursor: pageParam, limit: BATCH_PAGE_SIZE }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => (last.pageInfo.hasNextPage ? (last.pageInfo.endCursor ?? undefined) : undefined),
    refetchInterval: (query) => batchListPollInterval(query.state.data?.pages, visible, query.state.error),
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
      batchDetailPollInterval({ status: query.state.data?.status, error: query.state.error }, visible),
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

// POST /api/v1/batches/:id/attach-media: adds the ready outputs (of the given items, default all) to their Shopify
// products. It can take several seconds and is never repeated automatically. The detail is refreshed whatever the
// outcome: a request that timed out may have gone through, and a partial success must show what is on the products.
export function useAttachMedia() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, itemIds }: { id: string; itemIds?: string[] }) =>
      endpoints.batches.attachMedia(id, itemIds === undefined ? undefined : { itemIds }),
    retry: false,
    onSettled: (_data, _error, { id }) => queryClient.invalidateQueries({ queryKey: queryKeys.batches.detail(id) }),
  });
}

export function useRetryFailed() {
  const refresh = useRefreshBatches();
  return useMutation({ mutationFn: (id: string) => endpoints.batches.retryFailed(id), onSuccess: refresh });
}
