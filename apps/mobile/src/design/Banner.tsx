import { StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';
import { AppText } from './AppText';
import { Icon, type IconName } from './Icon';
import { PressableScale } from './PressableScale';
import { colors, components, layout, spacing } from './theme';
import { toneColors, type Tone } from './tones';

export interface BannerProps {
  tone?: Tone;
  title?: string;
  message: string;
  // Renders the action link as "Label →".
  actionLabel?: string;
  onAction?: () => void;
  // Overrides the default icon of the tone.
  icon?: IconName;
  style?: StyleProp<ViewStyle>;
}

const defaultIcons: Record<Tone, IconName> = {
  neutral: 'information-circle-outline',
  pending: 'time-outline',
  success: 'checkmark-circle-outline',
  warning: 'warning-outline',
  danger: 'alert-circle-outline',
};

// A tinted block with a 22 pt icon, title, message and an optional action link.
export function Banner({ tone = 'neutral', title, message, actionLabel, onAction, icon, style }: BannerProps) {
  const colorsForTone = toneColors[tone];
  const iconColor = tone === 'neutral' ? colors.ink : colorsForTone.text;

  return (
    <View accessibilityRole="alert" style={[styles.banner, { backgroundColor: colorsForTone.tint }, style]}>
      <Icon name={icon ?? defaultIcons[tone]} size={components.banner.iconSize} color={iconColor} />
      <View style={styles.body}>
        {title !== undefined && <AppText variant="cardTitle">{title}</AppText>}
        <AppText variant="body">{message}</AppText>
        {actionLabel !== undefined && onAction !== undefined && (
          <PressableScale onPress={onAction} style={styles.action}>
            <AppText variant="button">{`${actionLabel} →`}</AppText>
          </PressableScale>
        )}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  banner: {
    flexDirection: 'row',
    gap: spacing.sm + spacing.xs,
    padding: layout.cardPadding,
    borderRadius: components.banner.radius,
  },
  body: { flex: 1, gap: spacing.xs },
  action: { alignSelf: 'flex-start', paddingTop: spacing.xs },
});
