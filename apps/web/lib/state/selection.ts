import type { DraftProduct, ToggleResult } from './draftTypes';

// Product selection rules. The cap (maxProductsPerBatch from GET /me) is passed in by the caller.

export function selectionRoom(selected: number, maxProducts: number): number {
  return Math.max(0, maxProducts - selected);
}

export function isSelected(products: readonly DraftProduct[], id: string): boolean {
  return products.some((product) => product.id === id);
}

export function toggleSelection(
  products: readonly DraftProduct[],
  product: DraftProduct,
  maxProducts: number,
): { products: DraftProduct[]; result: ToggleResult } {
  if (isSelected(products, product.id)) {
    return { products: products.filter((candidate) => candidate.id !== product.id), result: 'removed' };
  }
  if (selectionRoom(products.length, maxProducts) === 0) return { products: [...products], result: 'limit' };
  return { products: [...products, product], result: 'added' };
}

// Drops duplicate ids, keeps the first maxProducts. `dropped` counts only the ones cut for the cap.
export function clampSelection(
  products: readonly DraftProduct[],
  maxProducts: number,
): { products: DraftProduct[]; dropped: number } {
  const unique = [...new Map(products.map((product) => [product.id, product])).values()];
  const kept = unique.slice(0, Math.max(0, maxProducts));
  return { products: kept, dropped: unique.length - kept.length };
}
