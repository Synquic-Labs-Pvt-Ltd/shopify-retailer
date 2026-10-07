import { useCallback, useState } from 'react';

// Drives a pull-to-refresh spinner from a refetch function. Background polling does not show it.
export function useManualRefresh(refetch: () => Promise<unknown>): { refreshing: boolean; onRefresh: () => void } {
  const [refreshing, setRefreshing] = useState(false);
  const onRefresh = useCallback(() => {
    setRefreshing(true);
    refetch()
      .catch(() => undefined)
      .finally(() => setRefreshing(false));
  }, [refetch]);
  return { refreshing, onRefresh };
}
