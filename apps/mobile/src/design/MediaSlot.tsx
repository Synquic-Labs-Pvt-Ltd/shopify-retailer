import { StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';
import { AppText } from './AppText';
import { Icon } from './Icon';
import { Image } from './Image';
import { PressableScale } from './PressableScale';
import { Spinner, ProgressBar } from './Progress';
import { borders, colors, components, pressScale, spacing } from './theme';

export type MediaSlotState = 'empty' | 'uploading' | 'processing' | 'ready' | 'failed';

export interface MediaSlotProps {
  state?: MediaSlotState;
  // Image uri, or the poster of a video. Shown in every non-empty state when present.
  uri?: string | null;
  // Adds the play glyph over the picture.
  isVideo?: boolean;
  // 0 to 1, drawn at the bottom of the slot while uploading.
  progress?: number;
  // Uppercase label below the slot.
  label?: string;
  // Hint under the "+" of an empty slot.
  hint?: string;
  // Empty: add. Failed: retry. Ready: open a preview.
  onPress?: () => void;
  // Shows the 26 pt scrim "x" at the top right of every non-empty slot.
  onRemove?: () => void;
  // Slot width. Rows of slots are 96 pt wide; the height follows the 0.8 aspect ratio.
  width?: number;
  style?: StyleProp<ViewStyle>;
}

const { aspectRatio, radius, removeButtonSize, plusSize } = components.mediaSlot;

export function MediaSlot({
  state = 'empty',
  uri,
  isVideo = false,
  progress = 0,
  label,
  hint,
  onPress,
  onRemove,
  width = 96,
  style,
}: MediaSlotProps) {
  const empty = state === 'empty';
  const failed = state === 'failed';
  const dimmed = state === 'uploading' || state === 'processing';
  const interactive = onPress !== undefined && (empty || failed || state === 'ready');

  return (
    <View style={[{ width, gap: spacing.xs }, style]}>
      <View style={[styles.slot, empty && styles.empty, failed && styles.failed]}>
        <PressableScale
          scale={interactive ? pressScale.tile : 1}
          haptic={interactive ? 'light' : false}
          accessibilityRole={interactive ? 'button' : 'image'}
          onPress={interactive ? onPress : undefined}
          accessibilityLabel={slotAccessibilityLabel(state, label)}
          style={[StyleSheet.absoluteFill, styles.content]}
        >
          {empty ? (
            <>
              <Icon name="add-outline" size={plusSize} color={colors.meta} />
              {hint !== undefined && (
                <AppText variant="meta" color={colors.meta} numberOfLines={1}>
                  {hint}
                </AppText>
              )}
            </>
          ) : (
            <>
              <Image uri={uri} style={StyleSheet.absoluteFill} />
              {dimmed && <View style={[StyleSheet.absoluteFill, styles.dim]} />}
              {state === 'processing' && <Spinner size={24} />}
              {failed && <Icon name="refresh-outline" size={components.icons.largeMin} color={colors.danger} />}
              {isVideo && state === 'ready' && (
                <View style={styles.play}>
                  <Icon name="play-outline" size={components.icons.rowMax} color={colors.accentInk} />
                </View>
              )}
              {state === 'uploading' && <ProgressBar progress={progress} style={styles.progress} />}
            </>
          )}
        </PressableScale>
        {!empty && onRemove !== undefined && (
          <PressableScale
            scale={pressScale.iconButton}
            accessibilityLabel="Remove"
            onPress={onRemove}
            style={styles.remove}
          >
            <Icon name="close-outline" size={16} color={colors.accentInk} />
          </PressableScale>
        )}
      </View>
      {label !== undefined && (
        <AppText variant="sectionLabel" color={colors.meta} numberOfLines={1}>
          {label}
        </AppText>
      )}
    </View>
  );
}

function slotAccessibilityLabel(state: MediaSlotState, label: string | undefined): string {
  const name = label ?? 'Reference';
  switch (state) {
    case 'empty':
      return `Add ${name}`;
    case 'uploading':
      return `${name}, uploading`;
    case 'processing':
      return `${name}, processing`;
    case 'failed':
      return `${name}, failed. Tap to retry`;
    case 'ready':
      return name;
  }
}

const styles = StyleSheet.create({
  slot: {
    aspectRatio,
    borderRadius: radius,
    backgroundColor: colors.surface,
    overflow: 'hidden',
  },
  empty: {
    borderWidth: borders.dashedWidth,
    borderStyle: 'dashed',
    borderColor: borders.hairlineColor,
  },
  failed: { borderWidth: borders.selectedTileWidth, borderColor: colors.danger },
  content: { alignItems: 'center', justifyContent: 'center', gap: spacing.xs },
  dim: { backgroundColor: colors.selectedTileDim },
  play: {
    width: 32,
    height: 32,
    borderRadius: 16,
    backgroundColor: colors.scrim,
    alignItems: 'center',
    justifyContent: 'center',
  },
  progress: { position: 'absolute', left: 0, right: 0, bottom: 0, borderRadius: 0 },
  remove: {
    position: 'absolute',
    top: spacing.xs + 2,
    right: spacing.xs + 2,
    width: removeButtonSize,
    height: removeButtonSize,
    borderRadius: removeButtonSize / 2,
    backgroundColor: colors.scrim,
    alignItems: 'center',
    justifyContent: 'center',
  },
});
