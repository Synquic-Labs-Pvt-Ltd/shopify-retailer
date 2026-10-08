import type { BatchItemView } from '@rs/shared';
import { itemSummaryText, type ViewerTarget } from './logic';
import { OutputGrid } from './OutputGrid';
import { ItemStatusBadge } from './StatusBadge';

interface ItemSectionProps {
  item: BatchItemView;
  // Outputs the batch plans for every product (images plus videos).
  expected: number;
  onOpen: (target: ViewerTarget) => void;
}

// One product of the generation: its header and the grid of its outputs.
export function ItemSection({ item, expected, onOpen }: ItemSectionProps) {
  return (
    <s-section>
      <s-stack gap="base">
        <s-grid gridTemplateColumns="auto 1fr auto" alignItems="center" gap="base">
          <s-thumbnail size="small-100" src={item.imageUrl ?? undefined} alt="" />
          <s-stack gap="small-500">
            <s-heading>{item.title}</s-heading>
            <s-text color="subdued">{itemSummaryText(item, expected)}</s-text>
          </s-stack>
          <ItemStatusBadge status={item.status} />
        </s-grid>
        <OutputGrid item={item} onOpen={onOpen} />
      </s-stack>
    </s-section>
  );
}
