import { memo } from 'react';
import { StyleSheet, View } from 'react-native';
import type { MediaObject } from '@rs/shared';
import { AppText, Icon, Image, PressableScale, Skeleton, colors, components, pressScale, radii, spacing } from '../../design';
import { formatDuration } from '../queue/format';

const { outputAspectRatio } = components.image;

export interface OutputTileProps {
  media: MediaObject;
  width: number;
  onPress: (media: MediaObject) => void;
}

// An image, or a video poster with a play glyph and a duration pill. Tapping opens the full-screen viewer.
export const OutputTile = memo(function OutputTile({ media, width, onPress }: OutputTileProps) {
  const isVideo = media.mediaType === 'video';
  return (
    <PressableScale
      scale={pressScale.tile}
      onPress={() => onPress(media)}
      accessibilityLabel={`${isVideo ? 'Video' : 'Image'}${media.shotTitle === null ? '' : `, ${media.shotTitle}`}`}
      style={[styles.tile, { width }]}
    >
      <Image uri={media.previewUrl ?? media.url} radius={radii.card} style={StyleSheet.absoluteFill} />
      {isVideo && (
        <>
          <View style={styles.playWrap} pointerEvents="none">
            <View style={styles.play}>
              <Icon name="play-outline" size={components.icons.rowMax} color={colors.accentInk} />
            </View>
          </View>
          {media.durationSec !== null && (
            <View style={styles.duration}>
              <AppText variant="pillSmall" color={colors.accentInk}>
                {formatDuration(media.durationSec)}
              </AppText>
            </View>
          )}
        </>
      )}
    </PressableScale>
  );
});

export function PendingTile({ width }: { width: number }) {
  return (
    <View style={[styles.tile, { width }]}>
      <Skeleton width="100%" height="100%" radius={radii.card} />
    </View>
  );
}

export interface FailedTileProps {
  width: number;
  isVideo: boolean;
  codeText: string;
}

// A failed job: a danger tile with the error code.
export function FailedTile({ width, isVideo, codeText }: FailedTileProps) {
  return (
    <View
      accessibilityLabel={`${isVideo ? 'Video' : 'Image'} failed: ${codeText}`}
      style={[styles.tile, styles.failed, { width }]}
    >
      <Icon name="alert-circle-outline" size={components.icons.largeMin} color={colors.danger} />
      <AppText variant="cardTitle" color={colors.danger}>
        {isVideo ? 'Video failed' : 'Image failed'}
      </AppText>
      <AppText variant="meta" color={colors.danger} style={styles.code}>
        {codeText}
      </AppText>
    </View>
  );
}

const styles = StyleSheet.create({
  tile: { aspectRatio: outputAspectRatio, borderRadius: radii.card, overflow: 'hidden' },
  playWrap: { ...StyleSheet.absoluteFill, alignItems: 'center', justifyContent: 'center' },
  play: {
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: colors.scrim,
    alignItems: 'center',
    justifyContent: 'center',
  },
  duration: {
    position: 'absolute',
    left: spacing.sm,
    bottom: spacing.sm,
    paddingHorizontal: spacing.sm,
    paddingVertical: 3,
    borderRadius: radii.pill,
    backgroundColor: colors.scrim,
  },
  failed: {
    backgroundColor: colors.tintDanger,
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.xs,
    padding: spacing.md,
  },
  code: { textAlign: 'center' },
});
