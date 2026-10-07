import { ScrollView, StyleSheet } from 'react-native';
import { MediaSlot, layout, spacing } from '../../design';
import type { DraftReference } from '../../state/draft';

export interface ReferenceSlotRowProps {
  refs: readonly DraftReference[];
  onRetry: (clientId: string) => void;
  onRemove: (clientId: string) => void;
  // Adds the dashed "+" slot at the end.
  onAdd?: () => void;
}

function slotImage(ref: DraftReference): string | null {
  return ref.previewUrl ?? (ref.mediaType === 'image' ? ref.localUri : null);
}

function slotLabel(ref: DraftReference): string {
  switch (ref.status) {
    case 'uploading':
      return `${Math.round(ref.progress * 100)}%`;
    case 'processing':
      return 'PROCESSING';
    case 'failed':
      return 'RETRY';
    case 'ready':
      return ref.mediaType === 'video' ? 'VIDEO' : 'IMAGE';
  }
}

// A horizontal row of 96 pt media slots. It bleeds to the edges of the card around it.
export function ReferenceSlotRow({ refs, onRetry, onRemove, onAdd }: ReferenceSlotRowProps) {
  return (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      style={styles.scroll}
      contentContainerStyle={styles.row}
    >
      {refs.map((ref) => (
        <MediaSlot
          key={ref.clientId}
          state={ref.status}
          uri={slotImage(ref)}
          isVideo={ref.mediaType === 'video'}
          progress={ref.progress}
          label={slotLabel(ref)}
          onPress={ref.status === 'failed' ? () => onRetry(ref.clientId) : undefined}
          onRemove={() => onRemove(ref.clientId)}
        />
      ))}
      {onAdd !== undefined && <MediaSlot onPress={onAdd} />}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  scroll: { marginHorizontal: -layout.cardPadding },
  row: { gap: spacing.sm + spacing.xs, paddingHorizontal: layout.cardPadding },
});
