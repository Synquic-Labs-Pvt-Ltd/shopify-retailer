import { StyleSheet, View } from 'react-native';
import type { MediaObject } from '@rs/shared';
import { AppText, Icon, Image, Skeleton, colors, components, radii, spacing } from '../../design';

const CELLS = 4;
const { slotAspectRatio } = components.image;

export interface OutputStripProps {
  outputs: readonly MediaObject[];
  // How many outputs the batch asks for per product.
  expected: number;
  // True while the item can still produce outputs: the missing ones pulse as skeletons.
  active: boolean;
}

// Four 0.8 thumbnails of the outputs as they arrive. More than four show "+N" on the last one.
export function OutputStrip({ outputs, expected, active }: OutputStripProps) {
  const total = Math.max(expected, outputs.length);
  const hidden = total > CELLS ? total - (CELLS - 1) : 0;

  return (
    <View style={styles.strip}>
      {Array.from({ length: CELLS }, (_, index) => {
        if (index >= total) return <View key={index} style={styles.cell} />;
        const output = outputs[index];
        if (output === undefined) {
          return active ? (
            <View key={index} style={styles.cell}>
              <Skeleton width="100%" height="100%" radius={radii.small} />
            </View>
          ) : (
            <View key={index} style={[styles.cell, styles.empty]} />
          );
        }
        const overflow = hidden > 0 && index === CELLS - 1;
        return (
          <View key={index} style={styles.cell}>
            <Image
              uri={output.previewUrl ?? output.url}
              radius={radii.small}
              accessibilityLabel={output.shotTitle ?? 'Output'}
              style={StyleSheet.absoluteFill}
            />
            {output.mediaType === 'video' && !overflow && (
              <View style={styles.play}>
                <Icon name="play-outline" size={14} color={colors.accentInk} />
              </View>
            )}
            {overflow && (
              <View style={styles.overflow}>
                <AppText variant="chip" color={colors.accentInk}>{`+${hidden}`}</AppText>
              </View>
            )}
          </View>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  strip: { flexDirection: 'row', gap: spacing.sm },
  cell: { flex: 1, aspectRatio: slotAspectRatio, borderRadius: radii.small },
  empty: { backgroundColor: colors.tintNeutral },
  play: {
    position: 'absolute',
    right: spacing.xs,
    bottom: spacing.xs,
    width: 22,
    height: 22,
    borderRadius: 11,
    backgroundColor: colors.scrim,
    alignItems: 'center',
    justifyContent: 'center',
  },
  overflow: {
    ...StyleSheet.absoluteFill,
    borderRadius: radii.small,
    backgroundColor: colors.scrim,
    alignItems: 'center',
    justifyContent: 'center',
  },
});
