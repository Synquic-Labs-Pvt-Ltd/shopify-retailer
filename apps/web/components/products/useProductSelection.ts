import type { ProductListItem } from '@rs/shared';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { endpoints } from '@/lib/api/endpoints';
import { fetchAllProducts, tabStatusFilter, type ProductStatusTab } from '@/lib/api/products';
import { showToast } from '@/lib/shopify';
import { useDraftStore } from '@/lib/state';
import {
  applySelectAll,
  busyLabel,
  checkState,
  limitMessage,
  matchSummary,
  productFilterKey,
  toDraftProduct,
  type CheckState,
  type MatchSummary,
  type SelectAction,
} from './logic';

export interface ProductFilter {
  // The search the list is showing (already debounced).
  search: string;
  tab: ProductStatusTab;
}

// The select-all of one (search, tab) pair: fetching its pages, or failed.
type Run =
  | { key: string; phase: 'running'; action: SelectAction }
  | { key: string; phase: 'failed'; action: SelectAction; error: unknown };

// The selection lives in the persisted draft, so it survives a change of search or tab and a reload.
//
// The header checkbox acts on everything the current search and tab match, not on the rendered page: it fetches all
// pages (see fetchAllProducts), then selects up to the cap or deselects them all. What it found is kept per
// (search, tab) so the checkbox shows the right state on every page; until then it reflects the rendered page.
export function useProductSelection(listed: readonly ProductListItem[], filter: ProductFilter, maxProducts: number) {
  const key = productFilterKey(filter.search, filter.tab);
  const selection = useDraftStore((state) => state.products);
  const selectedIds = useMemo(() => new Set(selection.map((product) => product.id)), [selection]);

  const [found, setFound] = useState<Readonly<Record<string, readonly ProductListItem[]>>>({});
  const matching = found[key];
  const [run, setRun] = useState<Run | null>(null);
  const current = run !== null && run.key === key ? run : null;
  const pending = useRef<AbortController | null>(null);

  // A new search or tab, or leaving the page, abandons the fetch in progress (and forgets how it was going).
  useEffect(
    () => () => {
      pending.current?.abort();
      pending.current = null;
      setRun(null);
    },
    [key],
  );

  const headerState: CheckState = useMemo(
    () => checkState(matching ?? listed, selectedIds),
    [matching, listed, selectedIds],
  );
  const summary: MatchSummary | null = useMemo(
    () => (matching === undefined ? null : matchSummary(matching, selectedIds)),
    [matching, selectedIds],
  );

  // Idempotent: a change event that repeats the current state does nothing.
  const setSelected = useCallback(
    (item: ProductListItem, selected: boolean): void => {
      const draft = useDraftStore.getState();
      if (draft.products.some((product) => product.id === item.id) === selected) return;
      if (draft.toggleProduct(toDraftProduct(item), maxProducts) === 'limit') {
        showToast(limitMessage(maxProducts), true);
      }
    },
    [maxProducts],
  );

  const applyTo = useCallback(
    (action: SelectAction, items: readonly ProductListItem[]): void => {
      const draft = useDraftStore.getState();
      const { products, message } = applySelectAll(action, draft.products, items, maxProducts);
      draft.setProducts(products, maxProducts);
      if (message !== null) showToast(message);
    },
    [maxProducts],
  );

  const runAll = useCallback(
    async (action: SelectAction): Promise<void> => {
      // Taking products out needs no fetch when the whole result is known already.
      if (action === 'deselect' && matching !== undefined) {
        applyTo(action, matching);
        setRun(null);
        return;
      }
      pending.current?.abort();
      const controller = new AbortController();
      pending.current = controller;
      setRun({ key, phase: 'running', action });
      try {
        const q = filter.search.trim();
        const items = await fetchAllProducts(
          endpoints.products.list,
          { q: q === '' ? undefined : q, status: tabStatusFilter(filter.tab) },
          controller.signal,
        );
        setFound((previous) => ({ ...previous, [key]: items }));
        applyTo(action, items);
        setRun(null);
      } catch (error) {
        // Abandoned (another search or tab, or the page was left): nothing to report.
        if (controller.signal.aborted) return;
        setRun({ key, phase: 'failed', action, error });
      } finally {
        if (pending.current === controller) pending.current = null;
      }
    },
    [applyTo, filter.search, filter.tab, key, matching],
  );

  const setAllSelected = useCallback(
    (selected: boolean): void => {
      if (current?.phase === 'running') return;
      void runAll(selected ? 'select' : 'deselect');
    },
    [current?.phase, runAll],
  );

  const retry = useCallback((): void => {
    if (current?.phase === 'failed') void runAll(current.action);
  }, [current, runAll]);

  const clear = useCallback((): void => useDraftStore.getState().clearSelection(), []);

  return {
    count: selection.length,
    selectedIds,
    headerState,
    // How much of the whole result is selected; null until a select-all has fetched it.
    summary,
    // "Selecting products..." while every page is being fetched; null otherwise.
    busy: current?.phase === 'running' ? busyLabel(current.action) : null,
    // Set when fetching the pages failed; retry repeats the action.
    failure: current?.phase === 'failed' ? { error: current.error } : null,
    setSelected,
    setAllSelected,
    retry,
    clear,
  };
}
