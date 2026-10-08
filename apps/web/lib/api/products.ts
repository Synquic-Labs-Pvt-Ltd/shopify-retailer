import type { ProductListItem, ProductStatus } from '@rs/shared';

// The products API only filters by title (`q`), so the Active and Draft tabs filter the loaded items client side.
export const PRODUCT_STATUS_TABS = ['all', 'active', 'draft'] as const;
export type ProductStatusTab = (typeof PRODUCT_STATUS_TABS)[number];

const TAB_STATUS: Record<Exclude<ProductStatusTab, 'all'>, ProductStatus> = {
  active: 'ACTIVE',
  draft: 'DRAFT',
};

// "All" keeps every status, including archived and unlisted products.
export function filterProductsByStatus<T extends Pick<ProductListItem, 'status'>>(
  items: readonly T[],
  tab: ProductStatusTab,
): T[] {
  if (tab === 'all') return [...items];
  const status = TAB_STATUS[tab];
  return items.filter((item) => item.status === status);
}
