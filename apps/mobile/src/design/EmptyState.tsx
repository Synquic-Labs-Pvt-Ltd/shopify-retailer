import { StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';
import { AppText } from './AppText';
import { Icon, type IconName } from './Icon';
import { PrimaryButton } from './PrimaryButton';
import { colors, components, spacing } from './theme';

export interface EmptyStateProps {
  icon: IconName;
  title: string;
  message?: string;
  // Optional pill button under the message.
  actionLabel?: string;
  onAction?: () => void;
  style?: StyleProp<ViewStyle>;
}

// A 56 pt white circle with a 26 pt meta icon, then title, message and an optional pill button.
export function EmptyState({ icon, title, message, actionLabel, onAction, style }: EmptyStateProps) {
  return (
    <View style={[styles.root, style]}>
      <View style={styles.circle}>
        <Icon name={icon} size={components.emptyState.iconSize} color={colors.meta} />
      </View>
      <View style={styles.texts}>
        <AppText variant="cardTitle" style={styles.centered}>
          {title}
        </AppText>
        {message !== undefined && (
          <AppText variant="body" color={colors.meta} style={styles.centered}>
            {message}
          </AppText>
        )}
      </View>
      {actionLabel !== undefined && onAction !== undefined && (
        <PrimaryButton label={actionLabel} onPress={onAction} style={styles.action} />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  root: { alignItems: 'center', gap: spacing.md, paddingVertical: spacing.xl, paddingHorizontal: spacing.lg },
  circle: {
    width: components.emptyState.circleSize,
    height: components.emptyState.circleSize,
    borderRadius: components.emptyState.circleSize / 2,
    backgroundColor: colors.surface,
    alignItems: 'center',
    justifyContent: 'center',
  },
  texts: { gap: spacing.xs, alignItems: 'center' },
  centered: { textAlign: 'center' },
  action: { paddingHorizontal: spacing.lg },
});
