'use client';

import { useRef } from 'react';
import { useElementEvent } from '@/components/polaris/useElementEvent';
import { PRODUCT_STATUS_TABS, type ProductStatusTab } from '@/lib/api/products';
import { TAB_LABELS } from './logic';

interface ProductsToolbarProps {
  tab: ProductStatusTab;
  onTabChange: (tab: ProductStatusTab) => void;
  search: string;
  onSearchChange: (search: string) => void;
}

// Status tabs on the left, title search on the right. The tabs filter the loaded products only.
export function ProductsToolbar({ tab, onTabChange, search, onSearchChange }: ProductsToolbarProps) {
  const searchRef = useRef<HTMLElementTagNameMap['s-search-field']>(null);
  const update = (element: HTMLElementTagNameMap['s-search-field']): void => onSearchChange(element.value);
  useElementEvent(searchRef, 'input', update);
  useElementEvent(searchRef, 'change', update);

  return (
    <s-box padding="small-100 base">
      <s-grid gridTemplateColumns="auto 1fr" gap="base" alignItems="center">
        <s-stack direction="inline" alignItems="center" gap="small-200">
          {PRODUCT_STATUS_TABS.map((value) => {
            const selected = value === tab;
            const label = TAB_LABELS[value];
            return (
              <s-clickable-chip
                key={value}
                color={selected ? 'strong' : 'base'}
                accessibilityLabel={selected ? `${label}, selected` : label}
                onClick={() => onTabChange(value)}
              >
                {label}
              </s-clickable-chip>
            );
          })}
        </s-stack>
        <s-search-field
          ref={searchRef}
          label="Search products"
          labelAccessibilityVisibility="exclusive"
          placeholder="Search products"
          value={search}
        />
      </s-grid>
    </s-box>
  );
}
