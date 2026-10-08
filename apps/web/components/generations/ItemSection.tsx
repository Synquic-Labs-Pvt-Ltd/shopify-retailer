import type { BatchItemView } from '@rs/shared';
import { usableOutputs } from '@/lib/batch/outputs';
import { attachState } from './attach';
import { ItemActions } from './ItemActions';
import { itemSummaryText, type ViewerTarget } from './logic';
import { OutputGrid } from './OutputGrid';
import { ItemStatusBadge } from './StatusBadge';

interface ItemSectionProps {
  item: BatchItemView;
  // Outputs the batch plans for every product (images plus videos).
  expected: number;
  // Any save or add request of the page is running.
  busy: boolean;
  // Set while this product's zip is being built.
  zipProgress: string | null;
  // This product's request to add its outputs is running.
  attaching: boolean;
  onOpen: (target: ViewerTarget) => void;
  onDownload: () => void;
  onAttach: () => void;
}

// One product of the generation: its header, what can be done with its outputs, and the grid of the outputs.
export function ItemSection({
  item,
  expected,
  busy,
  zipProgress,
  attaching,
  onOpen,
  onDownload,
  onAttach,
}: ItemSectionProps) {
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
        <ItemActions
          outputCount={usableOutputs(item).length}
          attachState={attachState(item)}
          attaching={attaching}
          busy={busy}
          zipProgress={zipProgress}
          onDownload={onDownload}
          onAttach={onAttach}
        />
        <OutputGrid item={item} onOpen={onOpen} />
      </s-stack>
    </s-section>
  );
}
