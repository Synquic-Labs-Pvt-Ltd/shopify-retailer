import type { ProductListItem, ProductStatus } from '@rs/shared';
import type { ProductStatusTab } from '@/lib/api/products';
import type { DraftProduct } from '@/lib/state/draftTypes';
import { selectionRoom } from '@/lib/state/selection';

// Pure rules of the Products page: selection, labels and copy.

export const DEFAULT_MAX_PRODUCTS = 50;
export const SEARCH_DEBOUNCE_MS = 350;

export function toDraftProduct(item: Pick<ProductListItem, 'id' | 'title' | 'imageUrl'>): DraftProduct {
  return { id: item.id, title: item.title, imageUrl: item.imageUrl };
}

export type CheckState = 'none' | 'some' | 'all';

// State of the header checkbox: how many of the listed products are selected.
export function checkState(listed: readonly Pick<ProductListItem, 'id'>[], selectedIds: ReadonlySet<string>): CheckState {
  if (listed.length === 0) return 'none';
  const selected = listed.filter((item) => selectedIds.has(item.id)).length;
  if (selected === 0) return 'none';
  return selected === listed.length ? 'all' : 'some';
}

export interface SelectAllResult {
  products: DraftProduct[];
  // Listed products that did not fit under the cap.
  truncated: number;
}

// Adds the listed products that are not selected yet, as many as the cap leaves room for.
export function selectListed(
  current: readonly DraftProduct[],
  listed: readonly ProductListItem[],
  maxProducts: number,
): SelectAllResult {
  const selectedIds = new Set(current.map((product) => product.id));
  const missing = listed.filter((item) => !selectedIds.has(item.id));
  const added = missing.slice(0, selectionRoom(current.length, maxProducts));
  return { products: [...current, ...added.map(toDraftProduct)], truncated: missing.length - added.length };
}

// Removes the listed products from the selection. Products selected on other tabs or searches stay.
export function deselectListed(current: readonly DraftProduct[], listed: readonly Pick<ProductListItem, 'id'>[]): DraftProduct[] {
  const listedIds = new Set(listed.map((item) => item.id));
  return current.filter((product) => !listedIds.has(product.id));
}

export const TAB_LABELS: Record<ProductStatusTab, string> = { all: 'All', active: 'Active', draft: 'Draft' };

export type BadgeTone = 'success' | 'info' | 'neutral';

const STATUS_BADGES: Record<ProductStatus, { label: string; tone: BadgeTone }> = {
  ACTIVE: { label: 'Active', tone: 'success' },
  DRAFT: { label: 'Draft', tone: 'info' },
  ARCHIVED: { label: 'Archived', tone: 'neutral' },
  UNLISTED: { label: 'Unlisted', tone: 'neutral' },
};

export function statusBadge(status: ProductStatus): { label: string; tone: BadgeTone } {
  return STATUS_BADGES[status];
}

export function selectedLabel(count: number): string {
  return `${count} selected`;
}

export function limitMessage(maxProducts: number): string {
  return `You can select up to ${maxProducts} products.`;
}

export function truncatedMessage(maxProducts: number): string {
  return `Selection is limited to ${maxProducts} products.`;
}

export interface EmptyCopy {
  heading: string;
  body: string;
}

export interface EmptyContext {
  searching: boolean;
  tab: ProductStatusTab;
  // More pages could still bring products of this tab.
  hasMore: boolean;
}

export function emptyCopy({ searching, tab, hasMore }: EmptyContext): EmptyCopy {
  if (tab !== 'all') {
    const name = TAB_LABELS[tab].toLowerCase();
    if (hasMore) {
      return { heading: `No ${name} products loaded yet`, body: 'Load more products to keep looking.' };
    }
    return {
      heading: `No ${name} products`,
      body: searching ? 'Try a different search.' : 'Switch to All to see every product.',
    };
  }
  return searching
    ? { heading: 'No products found', body: 'Try a different search.' }
    : { heading: 'No products yet', body: 'Products appear here once your store has some.' };
}
