import type { ReactNode } from 'react';
import { StyleSheet, type StyleProp, type ViewStyle } from 'react-native';
import { SafeAreaView, type Edge } from 'react-native-safe-area-context';
import { colors, layout } from './theme';

export interface ScreenProps {
  children?: ReactNode;
  // Safe-area edges to pad. Defaults to top and bottom.
  edges?: readonly Edge[];
  // 24 pt side padding. Defaults to true.
  padded?: boolean;
  style?: StyleProp<ViewStyle>;
}

export function Screen({ children, edges = ['top', 'bottom'], padded = true, style }: ScreenProps) {
  return (
    <SafeAreaView edges={edges} style={[styles.root, padded && styles.padded, style]}>
      {children}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.canvas },
  padded: { paddingHorizontal: layout.screenPaddingX },
});
