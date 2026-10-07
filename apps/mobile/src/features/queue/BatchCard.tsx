import { memo } from 'react';
import { StyleSheet, View } from 'react-native';
import type { BatchSummary } from '@rs/shared';
import {
  AppText,
  Image,
  PressableScale,
  ProgressBar,
  StatusChip,
  colors,
  components,
  pressScale,
  radii,
  spacing,
} from '../../design';
import { plural, relativeTime } from './format';
import { batchLabel, batchProgress, batchTone } from './status';

const COVER_WIDTH = 64;

export interface BatchCardProps {
  batch: BatchSummary;
  onPress: (batch: BatchSummary) => void;
}

// One batch in the Queue: cover thumbnail, "{n} products", age, status, progress and ready counts.
export const BatchCard = memo(function BatchCard({ batch, onPress }: BatchCardProps) {
  const { counts } = batch;
  const title = plural(counts.products, 'product');
  return (
    <PressableScale
      scale={pressScale.row}
      onPress={() => onPress(batch)}
      accessibilityLabel={`${title}, ${batchLabel(batch.status)}`}
      style={styles.card}
    >
      <Image
        uri={batch.coverImageUrl}
        aspectRatio={components.image.slotAspectRatio}
        radius={radii.small}
        style={styles.cover}
      />
      <View style={styles.body}>
        <View style={styles.titleRow}>
          <View style={styles.titles}>
            <AppText variant="cardTitle" numberOfLines={1}>
              {title}
            </AppText>
            <AppText variant="meta" color={colors.meta}>
              {relativeTime(batch.createdAt)}
            </AppText>
          </View>
          <StatusChip label={batchLabel(batch.status)} tone={batchTone(batch.status)} />
        </View>
        <ProgressBar progress={batchProgress(counts)} />
        <AppText variant="meta" color={colors.meta}>
          {`${plural(counts.imagesReady, 'image')} · ${plural(counts.videosReady, 'video')} ready`}
        </AppText>
      </View>
    </PressableScale>
  );
});

const styles = StyleSheet.create({
  card: {
    flexDirection: 'row',
    gap: spacing.md,
    padding: components.panel.padding,
    borderRadius: components.panel.radius,
    backgroundColor: colors.surface,
  },
  cover: { width: COVER_WIDTH },
  body: { flex: 1, justifyContent: 'space-between', gap: spacing.sm },
  titleRow: { flexDirection: 'row', alignItems: 'flex-start', gap: spacing.sm },
  titles: { flex: 1, gap: spacing.xs / 2 },
});
