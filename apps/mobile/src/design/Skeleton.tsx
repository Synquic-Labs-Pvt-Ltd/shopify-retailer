import { useEffect, useRef } from 'react';
import { Animated, Easing, type DimensionValue, type StyleProp, type ViewStyle } from 'react-native';
import { colors, components, radii } from './theme';

export interface SkeletonProps {
  width?: DimensionValue;
  height?: DimensionValue;
  radius?: number;
  style?: StyleProp<ViewStyle>;
}

// A cardGray block pulsing opacity 0.4 to 1 over 900 ms, ease in-out, repeating. No shimmer sweep.
export function Skeleton({ width = '100%', height = 16, radius = radii.small, style }: SkeletonProps) {
  const opacity = useRef(new Animated.Value(components.skeleton.minOpacity)).current;

  useEffect(() => {
    const pulse = (toValue: number) =>
      Animated.timing(opacity, {
        toValue,
        duration: components.skeleton.pulseMs,
        easing: Easing.inOut(Easing.ease),
        useNativeDriver: true,
      });
    const loop = Animated.loop(
      Animated.sequence([pulse(components.skeleton.maxOpacity), pulse(components.skeleton.minOpacity)]),
    );
    loop.start();
    return () => loop.stop();
  }, [opacity]);

  return (
    <Animated.View
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      style={[{ width, height, borderRadius: radius, backgroundColor: colors.cardGray, opacity }, style]}
    />
  );
}
