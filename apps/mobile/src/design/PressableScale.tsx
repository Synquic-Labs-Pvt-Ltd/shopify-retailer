import { useCallback, useRef, type ReactNode } from 'react';
import { Animated, Pressable, type PressableProps, type StyleProp, type ViewStyle } from 'react-native';
import { haptics } from './haptics';
import { components, pressScale, pressSpring, type HapticName } from './theme';

// Built on React Native's Animated spring, not reanimated, which drops first taps on the New Architecture.
const AnimatedPressable = Animated.createAnimatedComponent(Pressable);

export interface PressableScaleProps extends Omit<PressableProps, 'style' | 'children'> {
  // Pressed scale. Per element: icon buttons 0.9, chips 0.94, filter chips 0.95, rows and tiles 0.98, toggles 0.99.
  scale?: number;
  // Haptic on press-in. Pass false to disable.
  haptic?: HapticName | false;
  style?: StyleProp<ViewStyle>;
  children?: ReactNode;
}

export function PressableScale({
  scale = pressScale.default,
  haptic = 'light',
  disabled,
  hitSlop = components.press.hitSlop,
  pressRetentionOffset = components.press.retentionOffset,
  onPressIn,
  onPressOut,
  style,
  children,
  ...rest
}: PressableScaleProps) {
  const value = useRef(new Animated.Value(1)).current;

  const animateTo = useCallback(
    (toValue: number) => {
      Animated.spring(value, { toValue, ...pressSpring, useNativeDriver: true }).start();
    },
    [value],
  );

  return (
    <AnimatedPressable
      accessibilityRole="button"
      {...rest}
      disabled={disabled}
      hitSlop={hitSlop}
      pressRetentionOffset={pressRetentionOffset}
      onPressIn={(event) => {
        animateTo(scale);
        if (haptic !== false) haptics[haptic]();
        onPressIn?.(event);
      }}
      onPressOut={(event) => {
        animateTo(1);
        onPressOut?.(event);
      }}
      style={[style, { opacity: disabled ? components.press.disabledOpacity : 1, transform: [{ scale: value }] }]}
    >
      {children}
    </AnimatedPressable>
  );
}
