import { QueryClient } from '@tanstack/react-query';
import { ApiError } from './types';

// Client errors (4xx) are not retried; network and server errors get up to two retries.
function shouldRetry(failureCount: number, error: Error): boolean {
  if (error instanceof ApiError && error.status >= 400 && error.status < 500) return false;
  return failureCount < 2;
}

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: { staleTime: 30_000, retry: shouldRetry, refetchOnReconnect: true },
    mutations: { retry: 0 },
  },
});
