import type { ReactNode } from 'react';
import { StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';
import { KeyboardStickyView } from 'react-native-keyboard-controller';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { borders, colors, layout, spacing } from './theme';

export interface StickyFooterProps {
  children?: ReactNode;
  // How far the footer bleeds past its parent on both sides, so the hairline spans the screen.
  // Defaults to the 24 pt screen padding; pass 0 inside an unpadded Screen.
  bleed?: number;
  // Lift the footer with the keyboard. Defaults to true.
  followKeyboard?: boolean;
  style?: StyleProp<ViewStyle>;
}

// SPEC 17.6: a CTA footer with 16 vertical padding, a canvas background and a 1 px hairline top border.
// KeyboardStickyView lifts it above the keyboard. Place it last inside a Screen.
export function StickyFooter({ children, bleed = layout.screenPaddingX, followKeyboard = true, style }: StickyFooterProps) {
  const insets = useSafeAreaInsets();

  return (
    <KeyboardStickyView enabled={followKeyboard} offset={{ closed: 0, opened: insets.bottom }}>
      <View style={[styles.footer, { marginHorizontal: -bleed, paddingHorizontal: bleed }, style]}>{children}</View>
    </KeyboardStickyView>
  );
}

const styles = StyleSheet.create({
  footer: {
    paddingVertical: spacing.md,
    gap: spacing.sm,
    backgroundColor: colors.canvas,
    borderTopWidth: borders.hairlineWidth,
    borderTopColor: borders.hairlineColor,
  },
});
