import { useEffect, useRef } from 'react';
import { ActivityIndicator, Animated, Easing, StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';
import { colors, components, radii } from './theme';

export interface SpinnerProps {
  size?: number;
  color?: string;
  style?: StyleProp<ViewStyle>;
}

// Ring spinner: 64 pt with a 4 px hairline border and an ink top, one linear rotation per second.
// Smaller sizes keep the same 1:16 border ratio (never below 2 px).
export function Spinner({ size = components.progress.spinnerSize, color = colors.ink, style }: SpinnerProps) {
  const rotation = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    const loop = Animated.loop(
      Animated.timing(rotation, {
        toValue: 1,
        duration: components.progress.spinnerRotationMs,
        easing: Easing.linear,
        useNativeDriver: true,
      }),
    );
    loop.start();
    return () => loop.stop();
  }, [rotation]);

  const borderWidth =
    size === components.progress.spinnerSize
      ? components.progress.spinnerBorderWidth
      : Math.max(2, Math.round(size / 16));

  return (
    <Animated.View
      accessibilityRole="progressbar"
      style={[
        {
          width: size,
          height: size,
          borderRadius: size / 2,
          borderWidth,
          borderColor: colors.hairline,
          borderTopColor: color,
          transform: [{ rotate: rotation.interpolate({ inputRange: [0, 1], outputRange: ['0deg', '360deg'] }) }],
        },
        style,
      ]}
    />
  );
}

export interface ProgressBarProps {
  // 0 to 1. Values outside the range are clamped.
  progress: number;
  style?: StyleProp<ViewStyle>;
}

// 6 pt hairline track with an ink fill.
export function ProgressBar({ progress, style }: ProgressBarProps) {
  const clamped = Math.min(1, Math.max(0, Number.isFinite(progress) ? progress : 0));
  return (
    <View
      accessibilityRole="progressbar"
      accessibilityValue={{ min: 0, max: 100, now: Math.round(clamped * 100) }}
      style={[styles.track, style]}
    >
      <View style={[styles.fill, { width: `${clamped * 100}%` }]} />
    </View>
  );
}

export interface InkActivityIndicatorProps {
  size?: 'small' | 'large';
  color?: string;
}

// The system activity indicator in ink, for inline waits.
export function InkActivityIndicator({ size = 'small', color = colors.ink }: InkActivityIndicatorProps) {
  return <ActivityIndicator size={size} color={color} />;
}

const styles = StyleSheet.create({
  track: {
    height: components.progress.barHeight,
    borderRadius: radii.pill,
    backgroundColor: colors.hairline,
    overflow: 'hidden',
  },
  fill: { height: '100%', borderRadius: radii.pill, backgroundColor: colors.ink },
});
