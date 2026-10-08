import type { InfiniteData } from '@tanstack/react-query';

// Every item of the pages an infinite query has loaded so far, in order. Empty before the first page arrives.
export function pageItems<T>(data: InfiniteData<{ items: readonly T[] }> | undefined): T[] {
  return data === undefined ? [] : data.pages.flatMap((page) => page.items);
}
