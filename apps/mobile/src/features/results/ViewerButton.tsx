import { ActivityIndicator, StyleSheet, type StyleProp, type ViewStyle } from 'react-native';
import { Icon, PressableScale, colors, components, pressScale, type IconName } from '../../design';

const SIZE = 40;

export interface ViewerButtonProps {
  icon: IconName;
  accessibilityLabel: string;
  onPress: () => void;
  // Replaces the icon with a spinner.
  busy?: boolean;
  style?: StyleProp<ViewStyle>;
}

// The 40 pt circle of the viewer, on rgba(0,0,0,0.35).
export function ViewerButton({ icon, accessibilityLabel, onPress, busy = false, style }: ViewerButtonProps) {
  return (
    <PressableScale
      scale={pressScale.iconButton}
      accessibilityLabel={accessibilityLabel}
      onPress={busy ? undefined : onPress}
      style={[styles.button, style]}
    >
      {busy ? (
        <ActivityIndicator size="small" color={colors.accentInk} />
      ) : (
        <Icon name={icon} size={components.icons.rowMax} color={colors.accentInk} />
      )}
    </PressableScale>
  );
}

const styles = StyleSheet.create({
  button: {
    width: SIZE,
    height: SIZE,
    borderRadius: SIZE / 2,
    backgroundColor: colors.viewerControl,
    alignItems: 'center',
    justifyContent: 'center',
  },
});
