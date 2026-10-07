import { StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';
import { AppText } from './AppText';
import { Icon, type IconName } from './Icon';
import { PressableScale } from './PressableScale';
import { colors, components, pressScale } from './theme';

export interface IconButtonProps {
  icon: IconName;
  onPress?: () => void;
  // Required: an icon has no text for screen readers.
  accessibilityLabel: string;
  // Black circle with a white icon instead of a white circle.
  primary?: boolean;
  // Red count badge at the top right. Hidden at 0 or less.
  badgeCount?: number;
  // 8 pt red dot at the top right. Ignored when a badge count is shown.
  dot?: boolean;
  disabled?: boolean;
  style?: StyleProp<ViewStyle>;
}

const { size, badgeSize, badgeRingWidth, dotSize } = components.iconButton;

// A 44 pt circle, white (or black for primary), with an optional count badge or dot.
export function IconButton({
  icon,
  onPress,
  accessibilityLabel,
  primary = false,
  badgeCount,
  dot = false,
  disabled,
  style,
}: IconButtonProps) {
  const showBadge = badgeCount !== undefined && badgeCount > 0;

  return (
    <PressableScale
      scale={pressScale.iconButton}
      disabled={disabled}
      onPress={onPress}
      accessibilityLabel={accessibilityLabel}
      style={[styles.button, { backgroundColor: primary ? colors.accent : colors.surface }, style]}
    >
      <Icon name={icon} size={components.icons.rowMax} color={primary ? colors.accentInk : colors.ink} />
      {showBadge && (
        <View style={styles.badge}>
          <AppText variant="pillSmall" color={colors.accentInk} style={styles.badgeText}>
            {badgeCount > 99 ? '99+' : String(badgeCount)}
          </AppText>
        </View>
      )}
      {!showBadge && dot && <View style={styles.dot} />}
    </PressableScale>
  );
}

const styles = StyleSheet.create({
  button: { width: size, height: size, borderRadius: size / 2, alignItems: 'center', justifyContent: 'center' },
  badge: {
    position: 'absolute',
    top: -badgeRingWidth - 2,
    right: -badgeRingWidth - 2,
    minWidth: badgeSize,
    height: badgeSize,
    paddingHorizontal: 4,
    borderRadius: badgeSize / 2,
    borderWidth: badgeRingWidth,
    borderColor: colors.canvas,
    backgroundColor: colors.danger,
    alignItems: 'center',
    justifyContent: 'center',
  },
  badgeText: { textAlign: 'center', fontSize: 10, lineHeight: 12 },
  dot: {
    position: 'absolute',
    top: 8,
    right: 8,
    width: dotSize,
    height: dotSize,
    borderRadius: dotSize / 2,
    backgroundColor: colors.danger,
  },
});
