import type { ProductListItem } from '@rs/shared';
import { useCallback, useMemo } from 'react';
import { showToast } from '@/lib/shopify';
import { useDraftStore } from '@/lib/state';
import {
  checkState,
  deselectListed,
  limitMessage,
  selectListed,
  toDraftProduct,
  truncatedMessage,
  type CheckState,
} from './logic';

// The selection lives in the persisted draft, so it survives a change of search or tab and a reload.
export function useProductSelection(listed: readonly ProductListItem[], maxProducts: number) {
  const selection = useDraftStore((state) => state.products);
  const selectedIds = useMemo(() => new Set(selection.map((product) => product.id)), [selection]);
  const headerState: CheckState = useMemo(() => checkState(listed, selectedIds), [listed, selectedIds]);

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

  const setAllSelected = useCallback(
    (selected: boolean): void => {
      const draft = useDraftStore.getState();
      if (!selected) {
        draft.setProducts(deselectListed(draft.products, listed), maxProducts);
        return;
      }
      const result = selectListed(draft.products, listed, maxProducts);
      draft.setProducts(result.products, maxProducts);
      if (result.truncated > 0) showToast(truncatedMessage(maxProducts));
    },
    [listed, maxProducts],
  );

  const clear = useCallback((): void => useDraftStore.getState().clearSelection(), []);

  return { count: selection.length, selectedIds, headerState, setSelected, setAllSelected, clear };
}
