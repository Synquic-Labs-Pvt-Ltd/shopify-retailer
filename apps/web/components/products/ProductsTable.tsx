'use client';

import type { ProductListItem } from '@rs/shared';
import { ProductThumb } from './ProductThumb';
import { SelectCheckbox } from './SelectCheckbox';
import { statusBadge, type CheckState } from './logic';

const SKELETON_ROWS = 6;

interface ProductsTableProps {
  items: readonly ProductListItem[];
  // True while the first page is loading: placeholder rows are shown instead of products.
  loading: boolean;
  selectedIds: ReadonlySet<string>;
  headerState: CheckState;
  // The selection is read from the draft, so it cannot change before the draft has been loaded.
  disabled: boolean;
  onToggle: (item: ProductListItem, selected: boolean) => void;
  onToggleAll: (selected: boolean) => void;
}

function SkeletonRow() {
  return (
    <s-table-row>
      <s-table-cell>
        <s-box background="subdued" borderRadius="base" inlineSize="16px" blockSize="16px" />
      </s-table-cell>
      <s-table-cell>
        <s-stack direction="inline" alignItems="center" gap="small">
          <s-box background="subdued" borderRadius="base" inlineSize="40px" blockSize="40px" />
          <s-box background="subdued" borderRadius="base" inlineSize="180px" blockSize="14px" />
        </s-stack>
      </s-table-cell>
      <s-table-cell>
        <s-box background="subdued" borderRadius="base" inlineSize="56px" blockSize="14px" />
      </s-table-cell>
      <s-table-cell>
        <s-box background="subdued" borderRadius="base" inlineSize="20px" blockSize="14px" />
      </s-table-cell>
      <s-table-cell>
        <s-box background="subdued" borderRadius="base" inlineSize="20px" blockSize="14px" />
      </s-table-cell>
      <s-table-cell>
        <s-box background="subdued" borderRadius="base" inlineSize="90px" blockSize="14px" />
      </s-table-cell>
    </s-table-row>
  );
}

function ProductRow({
  item,
  selected,
  disabled,
  onToggle,
}: {
  item: ProductListItem;
  selected: boolean;
  disabled: boolean;
  onToggle: (item: ProductListItem, selected: boolean) => void;
}) {
  const badge = statusBadge(item.status);
  return (
    <s-table-row>
      <s-table-cell>
        <SelectCheckbox
          checked={selected}
          disabled={disabled}
          label={`Select ${item.title}`}
          onToggle={(checked) => onToggle(item, checked)}
        />
      </s-table-cell>
      <s-table-cell>
        <s-stack direction="inline" alignItems="center" gap="small">
          <ProductThumb imageUrl={item.imageUrl} title={item.title} />
          <s-text type="strong">{item.title}</s-text>
        </s-stack>
      </s-table-cell>
      <s-table-cell>
        <s-badge tone={badge.tone}>{badge.label}</s-badge>
      </s-table-cell>
      <s-table-cell>{item.mediaCount}</s-table-cell>
      <s-table-cell>{item.variantsCount}</s-table-cell>
      <s-table-cell>{item.vendor}</s-table-cell>
    </s-table-row>
  );
}

export function ProductsTable({ items, loading, selectedIds, headerState, disabled, onToggle, onToggleAll }: ProductsTableProps) {
  return (
    <s-table>
      <s-table-header-row>
        <s-table-header listSlot="inline">
          <SelectCheckbox
            checked={headerState === 'all'}
            indeterminate={headerState === 'some'}
            disabled={disabled || loading || items.length === 0}
            label="Select all listed products"
            onToggle={onToggleAll}
          />
        </s-table-header>
        <s-table-header listSlot="primary">Product</s-table-header>
        <s-table-header listSlot="secondary">Status</s-table-header>
        <s-table-header listSlot="labeled" format="numeric">
          Media
        </s-table-header>
        <s-table-header listSlot="labeled" format="numeric">
          Variants
        </s-table-header>
        <s-table-header listSlot="labeled">Vendor</s-table-header>
      </s-table-header-row>
      <s-table-body>
        {loading
          ? Array.from({ length: SKELETON_ROWS }, (_, index) => <SkeletonRow key={index} />)
          : items.map((item) => (
              <ProductRow
                key={item.id}
                item={item}
                selected={selectedIds.has(item.id)}
                disabled={disabled}
                onToggle={onToggle}
              />
            ))}
      </s-table-body>
    </s-table>
  );
}
