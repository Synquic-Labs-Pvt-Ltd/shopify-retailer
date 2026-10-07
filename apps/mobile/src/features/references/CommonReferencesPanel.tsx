import { AppText, Panel, colors } from '../../design';
import type { DraftReference } from '../../state/draft';
import { ReferenceSlotRow } from './ReferenceSlotRow';

export interface CommonReferencesPanelProps {
  refs: readonly DraftReference[];
  onAdd: () => void;
  onRetry: (clientId: string) => void;
  onRemove: (clientId: string) => void;
}

// SPEC 16.2: media that applies to every selected product.
export function CommonReferencesPanel({ refs, onAdd, onRetry, onRemove }: CommonReferencesPanelProps) {
  return (
    <Panel>
      <AppText variant="sectionLabel" color={colors.meta}>
        COMMON REFERENCES
      </AppText>
      <AppText variant="meta" color={colors.meta}>
        Used for every product without its own, and added to products that have their own.
      </AppText>
      <ReferenceSlotRow refs={refs} onAdd={onAdd} onRetry={onRetry} onRemove={onRemove} />
    </Panel>
  );
}
