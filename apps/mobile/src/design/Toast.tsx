import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Animated, Easing, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { AppText } from './AppText';
import { haptics } from './haptics';
import { colors, components, radii } from './theme';

export type ToastTone = 'success' | 'error' | 'info';

export interface ToastApi {
  // Shows a toast. A new toast replaces the one on screen. success and error fire a notification haptic.
  show: (message: string, tone?: ToastTone) => void;
  success: (message: string) => void;
  error: (message: string) => void;
}

interface ToastItem {
  id: number;
  message: string;
  tone: ToastTone;
}

const dotColors: Record<ToastTone, string> = {
  success: colors.success,
  error: colors.danger,
  info: colors.onDarkMuted,
};

const ToastContext = createContext<ToastApi | null>(null);

const { enterRise, enterDurationMinMs, enterDurationMaxMs, autoHideMs, bottomOffset } = components.toast;
const ENTER_MS = Math.round((enterDurationMinMs + enterDurationMaxMs) / 2);
const EXIT_MS = enterDurationMinMs;

// Mount once, inside the SafeAreaProvider. The toast is a black pill 90 pt above the bottom safe area.
export function ToastProvider({ children }: { children: ReactNode }) {
  const insets = useSafeAreaInsets();
  const [toast, setToast] = useState<ToastItem | null>(null);
  const nextId = useRef(0);
  const opacity = useRef(new Animated.Value(0)).current;
  const translateY = useRef(new Animated.Value(enterRise)).current;

  const show = useCallback((message: string, tone: ToastTone = 'info') => {
    nextId.current += 1;
    setToast({ id: nextId.current, message, tone });
    if (tone === 'success') haptics.success();
    if (tone === 'error') haptics.error();
  }, []);

  // Runs after the pill is mounted, so the native-driven animation always has a view to drive.
  useEffect(() => {
    if (toast === null) return undefined;
    opacity.setValue(0);
    translateY.setValue(enterRise);
    const enter = Animated.parallel([
      Animated.timing(opacity, { toValue: 1, duration: ENTER_MS, easing: Easing.out(Easing.cubic), useNativeDriver: true }),
      Animated.timing(translateY, {
        toValue: 0,
        duration: ENTER_MS,
        easing: Easing.out(Easing.cubic),
        useNativeDriver: true,
      }),
    ]);
    enter.start();
    const timer = setTimeout(() => {
      Animated.timing(opacity, { toValue: 0, duration: EXIT_MS, useNativeDriver: true }).start(({ finished }) => {
        if (finished) setToast((current) => (current?.id === toast.id ? null : current));
      });
    }, autoHideMs);
    return () => {
      enter.stop();
      clearTimeout(timer);
    };
  }, [toast, opacity, translateY]);

  const api = useMemo<ToastApi>(
    () => ({
      show,
      success: (message) => show(message, 'success'),
      error: (message) => show(message, 'error'),
    }),
    [show],
  );

  return (
    <ToastContext.Provider value={api}>
      {children}
      {toast !== null && (
        <View pointerEvents="none" style={[styles.overlay, { bottom: insets.bottom + bottomOffset }]}>
          <Animated.View
            accessibilityLiveRegion="polite"
            style={[styles.pill, { opacity, transform: [{ translateY }] }]}
          >
            <View style={[styles.dot, { backgroundColor: dotColors[toast.tone] }]} />
            <AppText variant="bodyMedium" color={colors.accentInk} style={styles.message}>
              {toast.message}
            </AppText>
          </Animated.View>
        </View>
      )}
    </ToastContext.Provider>
  );
}

export function useToast(): ToastApi {
  const api = useContext(ToastContext);
  if (api === null) throw new Error('useToast must be used inside ToastProvider');
  return api;
}

const styles = StyleSheet.create({
  overlay: { position: 'absolute', left: 0, right: 0, alignItems: 'center', paddingHorizontal: 24 },
  pill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    maxWidth: '100%',
    paddingHorizontal: components.toast.paddingX,
    paddingVertical: components.toast.paddingY,
    borderRadius: radii.pill,
    backgroundColor: colors.ink,
  },
  dot: {
    width: components.toast.dotSize,
    height: components.toast.dotSize,
    borderRadius: components.toast.dotSize / 2,
  },
  message: { flexShrink: 1 },
});
