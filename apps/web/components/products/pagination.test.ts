import { describe, expect, it } from 'vitest';
import {
  clampPageIndex,
  hasNextPage,
  hasPreviousPage,
  nextStep,
  positionFor,
  previousPageIndex,
  type PageWindow,
} from './pagination';

const window = (pageIndex: number, loadedPages: number, serverHasMore: boolean): PageWindow => ({
  pageIndex,
  loadedPages,
  serverHasMore,
});

describe('page controls', () => {
  it('has no previous page on the first page and one everywhere else', () => {
    expect(hasPreviousPage(window(0, 1, true))).toBe(false);
    expect(hasPreviousPage(window(1, 2, false))).toBe(true);
  });

  it('has a next page when another is loaded or the server has more', () => {
    expect(hasNextPage(window(0, 3, false))).toBe(true);
    expect(hasNextPage(window(2, 3, true))).toBe(true);
    expect(hasNextPage(window(2, 3, false))).toBe(false);
    expect(hasNextPage(window(0, 1, false))).toBe(false);
  });

  it('has neither while nothing is loaded', () => {
    expect(hasPreviousPage(window(0, 0, false))).toBe(false);
    expect(hasNextPage(window(0, 0, false))).toBe(false);
  });
});

describe('nextStep', () => {
  it('shows a page that is loaded already, without a request', () => {
    expect(nextStep(window(0, 3, true))).toEqual({ kind: 'show', pageIndex: 1 });
    expect(nextStep(window(1, 3, false))).toEqual({ kind: 'show', pageIndex: 2 });
  });

  it('fetches the next cursor past the last loaded page, to show at the index it arrives at', () => {
    expect(nextStep(window(0, 1, true))).toEqual({ kind: 'fetch', pageIndex: 1 });
    expect(nextStep(window(2, 3, true))).toEqual({ kind: 'fetch', pageIndex: 3 });
  });

  it('stops at the last page', () => {
    expect(nextStep(window(2, 3, false))).toEqual({ kind: 'none' });
    expect(nextStep(window(0, 0, false))).toEqual({ kind: 'none' });
  });

  it('walks forward through fetched pages and back through cached ones', () => {
    let state = window(0, 1, true);
    const visited: number[] = [];
    for (;;) {
      const step = nextStep(state);
      if (step.kind === 'none') break;
      // A fetch adds one page; the table moves to it.
      const loadedPages = step.kind === 'fetch' ? state.loadedPages + 1 : state.loadedPages;
      state = { pageIndex: step.pageIndex, loadedPages, serverHasMore: step.kind === 'fetch' ? step.pageIndex < 3 : state.serverHasMore };
      visited.push(step.pageIndex);
    }
    expect(visited).toEqual([1, 2, 3]);
    expect(state).toEqual(window(3, 4, false));

    // Back to the first page: every step is a cached page.
    const back: number[] = [];
    while (hasPreviousPage(state)) {
      state = { ...state, pageIndex: previousPageIndex(state.pageIndex) };
      back.push(state.pageIndex);
    }
    expect(back).toEqual([2, 1, 0]);
    // And forward again costs no request: the loaded pages are kept.
    expect(nextStep(state)).toEqual({ kind: 'show', pageIndex: 1 });
  });
});

describe('previousPageIndex and clampPageIndex', () => {
  it('never goes below the first page', () => {
    expect(previousPageIndex(3)).toBe(2);
    expect(previousPageIndex(0)).toBe(0);
  });

  it('keeps the page on show within the loaded pages, for example after a refetch dropped some', () => {
    expect(clampPageIndex(2, 3)).toBe(2);
    expect(clampPageIndex(5, 3)).toBe(2);
    expect(clampPageIndex(-1, 3)).toBe(0);
    expect(clampPageIndex(4, 0)).toBe(0);
  });
});

describe('positionFor', () => {
  it('restarts at the first page for any search or tab the position was not set for', () => {
    const position = { key: 'draft:lamp', index: 3 };
    expect(positionFor(position, 'draft:lamp')).toBe(3);
    expect(positionFor(position, 'draft:')).toBe(0);
    expect(positionFor(position, 'all:lamp')).toBe(0);
  });
});
