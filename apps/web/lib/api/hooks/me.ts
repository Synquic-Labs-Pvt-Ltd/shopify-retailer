import { useQuery } from '@tanstack/react-query';
import { endpoints } from '../endpoints';
import { queryKeys } from '../keys';

// GET /api/v1/me: user, shop and the read-only generation settings.
export function useMe() {
  return useQuery({ queryKey: queryKeys.me, queryFn: () => endpoints.me(), staleTime: 5 * 60_000 });
}
