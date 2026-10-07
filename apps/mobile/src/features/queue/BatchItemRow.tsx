import { memo } from 'react';
import { StyleSheet, View } from 'react-native';
import type { BatchItemView } from '@rs/shared';
import {
  AppText,
  Icon,
  Image,
  PressableScale,
  StatusChip,
  colors,
  components,
  pressScale,
  radii,
  spacing,
} from '../../design';
import { OutputStrip } from './OutputStrip';
import { isItemActive, itemLabel, itemTone } from './status';

export interface BatchItemRowProps {
  item: BatchItemView;
  expectedOutputs: number;
  onPress: (item: BatchItemView) => void;
}

// One product of a batch: thumbnail, status and the strip of outputs that have arrived. Opens ItemResults.
export const BatchItemRow = memo(function BatchItemRow({ item, expectedOutputs, onPress }: BatchItemRowProps) {
  return (
    <PressableScale
      scale={pressScale.row}
      onPress={() => onPress(item)}
      accessibilityLabel={`${item.title}, ${itemLabel(item.status)}`}
      style={styles.card}
    >
      <View style={styles.head}>
        <Image uri={item.imageUrl} radius={radii.small} style={styles.thumbnail} />
        <View style={styles.text}>
          <AppText variant="cardTitle" numberOfLines={1}>
            {item.title}
          </AppText>
          <StatusChip label={itemLabel(item.status)} tone={itemTone(item.status)} />
        </View>
        <Icon name="chevron-forward-outline" size={components.listRow.chevronSize} color={colors.meta} />
      </View>
      <OutputStrip outputs={item.outputs} expected={expectedOutputs} active={isItemActive(item.status)} />
    </PressableScale>
  );
});

const styles = StyleSheet.create({
  card: {
    gap: spacing.md,
    padding: components.panel.padding,
    borderRadius: components.panel.radius,
    backgroundColor: colors.surface,
  },
  head: { flexDirection: 'row', alignItems: 'center', gap: spacing.md },
  thumbnail: { width: components.listRow.thumbnailSize, height: components.listRow.thumbnailSize },
  text: { flex: 1, gap: spacing.xs + 2 },
});
