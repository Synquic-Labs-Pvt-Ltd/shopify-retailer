import { Image as ExpoImage, type ImageContentFit } from 'expo-image';
import { StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';
import { colors, components } from './theme';

export interface ImageProps {
  // null or undefined shows the cardGray placeholder only.
  uri?: string | null;
  // Aspect ratio of the box, width over height. Output tiles are 3 / 4, upload slots and strips 0.8.
  aspectRatio?: number;
  contentFit?: ImageContentFit;
  radius?: number;
  accessibilityLabel?: string;
  style?: StyleProp<ViewStyle>;
}

// expo-image with a 320 ms fade-in on a cardGray placeholder.
export function Image({
  uri,
  aspectRatio,
  contentFit = 'cover',
  radius = 0,
  accessibilityLabel,
  style,
}: ImageProps) {
  return (
    <View style={[styles.box, { borderRadius: radius }, aspectRatio !== undefined && { aspectRatio }, style]}>
      {uri !== undefined && uri !== null && uri !== '' && (
        <ExpoImage
          source={{ uri }}
          contentFit={contentFit}
          transition={components.image.fadeMs}
          accessibilityLabel={accessibilityLabel}
          style={StyleSheet.absoluteFill}
        />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  box: { backgroundColor: colors.cardGray, overflow: 'hidden' },
});
