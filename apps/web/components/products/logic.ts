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
  // Listed products that are in the selection afterwards (those that already were, plus the ones just added).
  selected: number;
  // All listed products.
  total: number;
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
  return {
    products: [...current, ...added.map(toDraftProduct)],
    truncated: missing.length - added.length,
    selected: listed.length - missing.length + added.length,
    total: listed.length,
  };
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

// What a select-all that hit the cap says: how many of the matching products were selected, and why not more.
export function truncatedMessage(maxProducts: number, selected: number, total: number): string {
  if (selected === 0) return limitMessage(maxProducts);
  return `Selected the first ${selected} of ${total} products — a batch can hold at most ${maxProducts}.`;
}

// The toast after a select-all, or null when everything that matches was selected.
export function selectAllMessage(
  result: Pick<SelectAllResult, 'truncated' | 'selected' | 'total'>,
  maxProducts: number,
): string | null {
  return result.truncated > 0 ? truncatedMessage(maxProducts, result.selected, result.total) : null;
}

// How much of everything the current search and tab match is selected. Known once a select-all has fetched it.
export interface MatchSummary {
  selected: number;
  total: number;
}

export function matchSummary(
  matching: readonly Pick<ProductListItem, 'id'>[],
  selectedIds: ReadonlySet<string>,
): MatchSummary {
  return { selected: matching.filter((item) => selectedIds.has(item.id)).length, total: matching.length };
}

// The line under "137 selected": "All 137 products selected" when the whole result is in the selection, or
// "50 of 137 selected" when only part is (the cap stopped a select-all, or products were picked one by one).
export function selectionDetail(summary: MatchSummary | null): string | null {
  if (summary === null || summary.selected === 0) return null;
  if (summary.selected === summary.total) {
    return `All ${summary.total} ${summary.total === 1 ? 'product' : 'products'} selected`;
  }
  return `${summary.selected} of ${summary.total} selected`;
}

export type SelectAction = 'select' | 'deselect';

// What the header checkbox does to the selection once every product of the current search and tab is known: select
// them up to the cap, or take all of them out. Products selected under other searches or tabs stay.
export function applySelectAll(
  action: SelectAction,
  current: readonly DraftProduct[],
  matching: readonly ProductListItem[],
  maxProducts: number,
): { products: DraftProduct[]; message: string | null } {
  if (action === 'deselect') return { products: deselectListed(current, matching), message: null };
  const result = selectListed(current, matching, maxProducts);
  return { products: result.products, message: selectAllMessage(result, maxProducts) };
}

// Shown while a select-all (or deselect-all) fetches every page of the result.
export function busyLabel(action: SelectAction): string {
  return action === 'select' ? 'Selecting products...' : 'Deselecting products...';
}

// Identifies a search and tab: a select-all, and what it found, belongs to one of these.
export function productFilterKey(search: string, tab: ProductStatusTab): string {
  return `${tab}:${search.trim()}`;
}

export interface EmptyCopy {
  heading: string;
  body: string;
}

export interface EmptyContext {
  searching: boolean;
  tab: ProductStatusTab;
  // Another page follows this one. A page can be empty while the next one is not: products without an image are
  // left out, so a page may hold few products, or none.
  hasMore: boolean;
  // A page comes before this one.
  hasPrevious: boolean;
}

export function emptyCopy({ searching, tab, hasMore, hasPrevious }: EmptyContext): EmptyCopy {
  if (hasMore) {
    return {
      heading: 'No products to show on this page',
      body: 'Products without an image are hidden. Go to the next page to keep looking.',
    };
  }
  if (hasPrevious) {
    return {
      heading: 'No more products to show',
      body: 'Products without an image are hidden. Go back to the previous page.',
    };
  }
  if (tab !== 'all') {
    const name = TAB_LABELS[tab].toLowerCase();
    return {
      heading: `No ${name} products`,
      body: searching ? 'Try a different search.' : 'Switch to All to see every product.',
    };
  }
  return searching
    ? { heading: 'No products found', body: 'Try a different search.' }
    : { heading: 'No products yet', body: 'Products appear here once your store has some with an image.' };
}
