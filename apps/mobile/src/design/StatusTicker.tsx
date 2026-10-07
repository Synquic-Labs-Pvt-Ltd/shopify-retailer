import { useEffect, useRef, useState } from 'react';
import { Animated, Easing, StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';
import { AppText } from './AppText';
import { colors, motion } from './theme';

export interface StatusTickerProps {
  messages: readonly string[];
  // Time each message stays. Defaults to 1.8 s.
  intervalMs?: number;
  color?: string;
  style?: StyleProp<ViewStyle>;
}

const { outMs, inMs, offsetY } = motion.statusTicker;

// Rotating status messages. The outgoing one fades and moves up 8 pt in 220 ms; the incoming one enters from +8 pt in 260 ms.
export function StatusTicker({
  messages,
  intervalMs = motion.statusTicker.intervalMs,
  color = colors.meta,
  style,
}: StatusTickerProps) {
  const [index, setIndex] = useState(0);
  const opacity = useRef(new Animated.Value(1)).current;
  const translateY = useRef(new Animated.Value(0)).current;
  const count = messages.length;

  useEffect(() => {
    opacity.setValue(1);
    translateY.setValue(0);
    if (count < 2) return undefined;
    let running: Animated.CompositeAnimation | undefined;
    const timer = setInterval(() => {
      running = Animated.parallel([
        Animated.timing(opacity, { toValue: 0, duration: outMs, easing: Easing.out(Easing.quad), useNativeDriver: true }),
        Animated.timing(translateY, {
          toValue: -offsetY,
          duration: outMs,
          easing: Easing.out(Easing.quad),
          useNativeDriver: true,
        }),
      ]);
      running.start(({ finished }) => {
        if (!finished) return;
        setIndex((current) => (current + 1) % count);
        translateY.setValue(offsetY);
        running = Animated.parallel([
          Animated.timing(opacity, { toValue: 1, duration: inMs, easing: Easing.out(Easing.quad), useNativeDriver: true }),
          Animated.timing(translateY, { toValue: 0, duration: inMs, easing: Easing.out(Easing.quad), useNativeDriver: true }),
        ]);
        running.start();
      });
    }, intervalMs);
    return () => {
      clearInterval(timer);
      running?.stop();
    };
  }, [count, intervalMs, opacity, translateY]);

  return (
    <View style={style} accessibilityLiveRegion="polite">
      <Animated.View style={{ opacity, transform: [{ translateY }] }}>
        <AppText variant="bodyMedium" color={color}>
          {messages[index % Math.max(count, 1)] ?? ''}
        </AppText>
      </Animated.View>
    </View>
  );
}
