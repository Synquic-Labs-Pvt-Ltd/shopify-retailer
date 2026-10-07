import type { ReactNode } from 'react';
import { StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';
import { colors, components } from './theme';

export interface PanelProps {
  children?: ReactNode;
  style?: StyleProp<ViewStyle>;
}

// White, radius 18, padding 16, gap 8. No shadow.
export function Panel({ children, style }: PanelProps) {
  return <View style={[styles.panel, style]}>{children}</View>;
}

const styles = StyleSheet.create({
  panel: {
    padding: components.panel.padding,
    gap: components.panel.gap,
    borderRadius: components.panel.radius,
    backgroundColor: colors.surface,
  },
});
