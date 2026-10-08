'use client';

import { selectedLabel } from './logic';

interface SelectionBarProps {
  // Products selected in all, whatever page, search or tab they came from.
  count: number;
  // "All 137 products selected" or "50 of 137 selected": how much of the current search and tab is in the selection.
  // Null while that is not known.
  detail: string | null;
  // "Selecting products..." while a select-all fetches every page; null otherwise.
  busy: string | null;
  onClear: () => void;
  onGenerate: () => void;
}

// Shown above the table while at least one product is selected (or being selected): the table has no bulk action slot.
export function SelectionBar({ count, detail, busy, onClear, onGenerate }: SelectionBarProps) {
  return (
    <s-box background="subdued" padding="small-100 base">
      <s-stack direction="inline" alignItems="center" justifyContent="space-between" gap="base">
        <s-stack direction="inline" alignItems="center" gap="base">
          {count > 0 ? (
            <s-stack gap="small-500">
              <s-heading>{selectedLabel(count)}</s-heading>
              {detail !== null ? <s-text color="subdued">{detail}</s-text> : null}
            </s-stack>
          ) : null}
          {busy !== null ? (
            <s-stack direction="inline" alignItems="center" gap="small-200">
              <s-spinner size="base" accessibilityLabel={busy} />
              <s-text color="subdued">{busy}</s-text>
            </s-stack>
          ) : null}
        </s-stack>
        {count > 0 ? (
          <s-stack direction="inline" alignItems="center" gap="small">
            <s-button variant="secondary" disabled={busy !== null} onClick={onClear}>
              Clear
            </s-button>
            <s-button variant="primary" disabled={busy !== null} onClick={onGenerate}>
              Generate content
            </s-button>
          </s-stack>
        ) : null}
      </s-stack>
    </s-box>
  );
}
