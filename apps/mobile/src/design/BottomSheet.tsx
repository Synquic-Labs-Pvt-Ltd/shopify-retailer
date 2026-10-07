import type { ReactNode } from 'react';
import { Modal, Pressable, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { AppText } from './AppText';
import { Icon, type IconName } from './Icon';
import { PressableScale } from './PressableScale';
import { colors, components, pressScale, radii, shadows, spacing } from './theme';

export interface BottomSheetProps {
  visible: boolean;
  onClose: () => void;
  title?: string;
  children?: ReactNode;
}

// A Modal that fades in with the scrim and never slides. Tapping the scrim or the Android back button closes it.
export function BottomSheet({ visible, onClose, title, children }: BottomSheetProps) {
  const insets = useSafeAreaInsets();

  return (
    <Modal
      transparent
      statusBarTranslucent
      navigationBarTranslucent
      animationType="fade"
      visible={visible}
      onRequestClose={onClose}
    >
      <View style={styles.root}>
        <Pressable accessibilityLabel="Close" style={styles.scrim} onPress={onClose} />
        <View style={[styles.panel, { paddingBottom: components.bottomSheet.padding + insets.bottom }]}>
          {title !== undefined && (
            <AppText variant="sheetTitle" accessibilityRole="header">
              {title}
            </AppText>
          )}
          {children}
        </View>
      </View>
    </Modal>
  );
}

export interface BottomSheetOptionProps {
  label: string;
  icon?: IconName;
  onPress: () => void;
  // Danger colors the label and icon red.
  danger?: boolean;
}

// A canvas-filled card (radius 18) for one choice in a sheet.
export function BottomSheetOption({ label, icon, onPress, danger = false }: BottomSheetOptionProps) {
  const color = danger ? colors.danger : colors.ink;
  return (
    <PressableScale scale={pressScale.row} onPress={onPress} style={styles.option}>
      {icon !== undefined && <Icon name={icon} size={components.icons.rowMax} color={color} />}
      <AppText variant="cardTitle" color={color}>
        {label}
      </AppText>
    </PressableScale>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, justifyContent: 'flex-end' },
  scrim: { ...StyleSheet.absoluteFill, backgroundColor: colors.scrim },
  panel: {
    gap: components.bottomSheet.gap,
    padding: components.bottomSheet.padding,
    borderTopLeftRadius: components.bottomSheet.topRadius,
    borderTopRightRadius: components.bottomSheet.topRadius,
    backgroundColor: colors.surface,
    ...shadows.bottomSheet,
  },
  option: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    padding: spacing.md,
    borderRadius: radii.card,
    backgroundColor: colors.canvas,
  },
});
