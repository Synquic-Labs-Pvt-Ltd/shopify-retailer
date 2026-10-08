// Pages of the Products table. The backend pages by cursor, so there is no "go to page 7": the pages visited so far
// stay loaded (an infinite query) and the table shows one of them by index. Going forward past the last loaded page
// asks for the next cursor, going back reuses a loaded page and costs no request.

export interface PageWindow {
  // Page on show, from 0.
  pageIndex: number;
  // Pages loaded so far.
  loadedPages: number;
  // The last loaded page is followed by one more on the server.
  serverHasMore: boolean;
}

// A background refetch can leave fewer pages than the table was on.
export function clampPageIndex(pageIndex: number, loadedPages: number): number {
  return Math.min(Math.max(pageIndex, 0), Math.max(loadedPages - 1, 0));
}

export const hasPreviousPage = ({ pageIndex }: PageWindow): boolean => pageIndex > 0;

export const hasNextPage = ({ pageIndex, loadedPages, serverHasMore }: PageWindow): boolean =>
  pageIndex + 1 < loadedPages || serverHasMore;

export const previousPageIndex = (pageIndex: number): number => Math.max(pageIndex - 1, 0);

export type NextStep =
  // The next page is loaded already: show it.
  | { kind: 'show'; pageIndex: number }
  // It is not: fetch it, then show the page that arrives at this index.
  | { kind: 'fetch'; pageIndex: number }
  | { kind: 'none' };

export function nextStep(pages: PageWindow): NextStep {
  if (pages.pageIndex + 1 < pages.loadedPages) return { kind: 'show', pageIndex: pages.pageIndex + 1 };
  if (pages.serverHasMore) return { kind: 'fetch', pageIndex: pages.loadedPages };
  return { kind: 'none' };
}

// The table page a (search, tab) pair is on. It restarts at the first page whenever the pair changes: a position
// remembers the pair it was set for and counts as the first page for any other (the view then replaces it).
export interface PagePosition {
  key: string;
  index: number;
}

export function positionFor(position: PagePosition, key: string): number {
  return position.key === key ? position.index : 0;
}
