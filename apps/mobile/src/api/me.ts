import { useQuery } from '@tanstack/react-query';
import { api } from './client';
import { queryKeys } from './keys';

export const meQueryKey = queryKeys.me;

// GET /api/v1/me: user, shop and the read-only generation settings.
export function useMe() {
  return useQuery({ queryKey: meQueryKey, queryFn: () => api.me(), staleTime: 5 * 60_000 });
}
