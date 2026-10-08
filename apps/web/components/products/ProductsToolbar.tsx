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
        <s-button-group gap="none" accessibilityLabel="Filter by status">
          {PRODUCT_STATUS_TABS.map((value) => (
            <s-press-button
              key={value}
              variant="tertiary"
              pressed={value === tab}
              onClick={(event) => {
                // The button flips itself when pressed: keep the chosen tab pressed.
                event.currentTarget.pressed = true;
                onTabChange(value);
              }}
            >
              {TAB_LABELS[value]}
            </s-press-button>
          ))}
        </s-button-group>
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
