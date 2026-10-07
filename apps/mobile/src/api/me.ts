import { useQuery } from '@tanstack/react-query';
import { api } from './client';

export const meQueryKey = ['me'] as const;

// GET /api/v1/me: user, shop and the read-only generation settings.
export function useMe() {
  return useQuery({ queryKey: meQueryKey, queryFn: () => api.me(), staleTime: 5 * 60_000 });
}
