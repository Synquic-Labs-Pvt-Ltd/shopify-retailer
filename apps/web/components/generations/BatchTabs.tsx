import { BATCH_TABS, BATCH_TAB_LABELS, type BatchTab } from './logic';

interface BatchTabsProps {
  tab: BatchTab;
  onChange: (tab: BatchTab) => void;
}

// Filter chips above the table. The selected chip is the strong one; the chips hold no state of their own.
export function BatchTabs({ tab, onChange }: BatchTabsProps) {
  return (
    <s-box padding="small base">
      <s-stack direction="inline" alignItems="center" gap="small-200">
        {BATCH_TABS.map((value) => {
          const selected = value === tab;
          const label = BATCH_TAB_LABELS[value];
          return (
            <s-clickable-chip
              key={value}
              color={selected ? 'strong' : 'base'}
              accessibilityLabel={selected ? `${label}, selected` : label}
              onClick={() => onChange(value)}
            >
              {label}
            </s-clickable-chip>
          );
        })}
      </s-stack>
    </s-box>
  );
}
