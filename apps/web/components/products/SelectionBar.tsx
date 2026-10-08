'use client';

import { selectedLabel } from './logic';

interface SelectionBarProps {
  count: number;
  onClear: () => void;
  onGenerate: () => void;
}

// Shown above the table while at least one product is selected: the table has no bulk action slot.
export function SelectionBar({ count, onClear, onGenerate }: SelectionBarProps) {
  return (
    <s-box background="subdued" padding="small-100 base">
      <s-stack direction="inline" alignItems="center" justifyContent="space-between" gap="base">
        <s-text type="strong">{selectedLabel(count)}</s-text>
        <s-stack direction="inline" alignItems="center" gap="small">
          <s-button variant="secondary" onClick={onClear}>
            Clear
          </s-button>
          <s-button variant="primary" onClick={onGenerate}>
            Generate content
          </s-button>
        </s-stack>
      </s-stack>
    </s-box>
  );
}
