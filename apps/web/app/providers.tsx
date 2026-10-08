'use client';

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useState, type ReactNode } from 'react';
import { queryRetryDelay, shouldRetryQuery } from '@/lib/api/retry';

export function Providers({ children }: { children: ReactNode }) {
  const [client] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          // apiRequest already retried transport trouble of the GET itself; a query gets one more try after a
          // longer pause (see lib/api/retry.ts). A mutation is never repeated automatically.
          queries: {
            retry: shouldRetryQuery,
            retryDelay: queryRetryDelay,
            staleTime: 10_000,
            refetchOnWindowFocus: true,
          },
          mutations: { retry: false },
        },
      }),
  );
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}
