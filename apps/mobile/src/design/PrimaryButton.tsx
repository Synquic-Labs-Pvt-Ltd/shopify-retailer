import { ActivityIndicator, StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';
import { AppText } from './AppText';
import { PressableScale } from './PressableScale';
import { borders, colors, components, radii } from './theme';
import type { HapticName } from './theme';

export type ButtonTone = 'accent' | 'ink' | 'danger' | 'surface' | 'ghost';

export interface PrimaryButtonProps {
  label: string;
  onPress?: () => void;
  tone?: ButtonTone;
  // Replaces the label with a spinner. The button keeps its size and ignores presses.
  loading?: boolean;
  disabled?: boolean;
  haptic?: HapticName | false;
  accessibilityLabel?: string;
  style?: StyleProp<ViewStyle>;
}

interface ToneStyle {
  background: string;
  text: string;
  border: string;
}

const toneStyles: Record<ButtonTone, ToneStyle> = {
  accent: { background: colors.accent, text: colors.accentInk, border: colors.accent },
  ink: { background: colors.ink, text: colors.accentInk, border: colors.ink },
  danger: { background: colors.danger, text: colors.accentInk, border: colors.danger },
  surface: { background: colors.surface, text: colors.ink, border: colors.surface },
  ghost: { background: 'transparent', text: colors.ink, border: colors.ink },
};

// A pill with 16 padding (about 52 pt tall). The label never wraps.
export function PrimaryButton({
  label,
  onPress,
  tone = 'accent',
  loading = false,
  disabled = false,
  haptic,
  accessibilityLabel,
  style,
}: PrimaryButtonProps) {
  const toneStyle = toneStyles[tone];

  return (
    <PressableScale
      haptic={haptic}
      disabled={disabled}
      onPress={loading ? undefined : onPress}
      accessibilityLabel={accessibilityLabel ?? label}
      accessibilityState={{ disabled, busy: loading }}
      style={[
        styles.button,
        { backgroundColor: toneStyle.background, borderColor: toneStyle.border },
        style,
      ]}
    >
      <AppText variant="button" color={toneStyle.text} numberOfLines={1} style={loading && styles.hidden}>
        {label}
      </AppText>
      {loading && (
        <View style={styles.spinner} pointerEvents="none">
          <ActivityIndicator size="small" color={toneStyle.text} />
        </View>
      )}
    </PressableScale>
  );
}

const styles = StyleSheet.create({
  button: {
    alignItems: 'center',
    justifyContent: 'center',
    // 16 pt in total including the 1.5 px border, so every tone is the same height.
    padding: components.primaryButton.padding - borders.outlineWidth,
    borderRadius: radii.pill,
    borderWidth: borders.outlineWidth,
  },
  hidden: { opacity: 0 },
  spinner: { ...StyleSheet.absoluteFill, alignItems: 'center', justifyContent: 'center' },
});
