import { useQuery } from '@tanstack/react-query';
import { endpoints } from '../endpoints';
import { queryKeys } from '../keys';

// SPEC 8.6 step 7: after POST /media/:id/complete the app polls GET /media?ids= until every reference is
// ready or failed. The wait grows from 1.5 s to 3 s between polls.
const POLL_MIN_MS = 1_500;
const POLL_MAX_MS = 3_000;
const POLL_STEP_MS = 300;

export function mediaPollDelay(pollsDone: number): number {
  return Math.min(POLL_MAX_MS, POLL_MIN_MS + pollsDone * POLL_STEP_MS);
}

// GET /api/v1/media?ids=. Pass the ids that are still processing; an empty list disables the query.
export function useMediaStatus(ids: readonly string[]) {
  const sorted = [...ids].sort();
  return useQuery({
    queryKey: queryKeys.media.status(sorted),
    queryFn: () => endpoints.media.list(sorted),
    enabled: sorted.length > 0,
    staleTime: 0,
    gcTime: 0,
    refetchInterval: (query) => mediaPollDelay(query.state.dataUpdateCount),
  });
}
