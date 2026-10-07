import type { ReactNode } from 'react';
import { StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';
import { AppText } from './AppText';
import { Icon, type IconName } from './Icon';
import { Image } from './Image';
import { PressableScale } from './PressableScale';
import { colors, components, pressScale, radii, spacing, type HapticName } from './theme';

export interface ListRowProps {
  label: string;
  // Meta text under the label.
  hint?: string;
  // 20 pt icon on the left.
  icon?: IconName;
  // 52 pt thumbnail (radius 10) on the left. null shows the cardGray placeholder. Wins over icon.
  thumbnailUri?: string | null;
  // 22 pt black count badge. Hidden at 0 or less.
  count?: number;
  // Right-side content, for example a value or a selection circle. Replaces the chevron.
  trailing?: ReactNode;
  // Chevron on the right. Defaults to true when the row is pressable and has no trailing content.
  chevron?: boolean;
  // Without onPress the row is a plain View: no press scale and no haptic.
  onPress?: () => void;
  haptic?: HapticName | false;
  accessibilityLabel?: string;
  style?: StyleProp<ViewStyle>;
}

const { radius, padding, gap, iconSize, thumbnailSize, countBadgeSize, chevronSize } = components.listRow;

// White, radius 18, padding 16, gap 16.
export function ListRow({
  label,
  hint,
  icon,
  thumbnailUri,
  count,
  trailing,
  chevron,
  onPress,
  haptic,
  accessibilityLabel,
  style,
}: ListRowProps) {
  const showChevron = chevron ?? (onPress !== undefined && trailing === undefined);
  const content = (
    <>
      {thumbnailUri !== undefined ? (
        <Image uri={thumbnailUri} radius={radii.small} style={styles.thumbnail} />
      ) : (
        icon !== undefined && <Icon name={icon} size={iconSize} />
      )}
      <View style={styles.text}>
        <AppText variant="cardTitle" numberOfLines={1}>
          {label}
        </AppText>
        {hint !== undefined && (
          <AppText variant="meta" color={colors.meta} numberOfLines={1}>
            {hint}
          </AppText>
        )}
      </View>
      {count !== undefined && count > 0 && (
        <View style={styles.count}>
          <AppText variant="pillSmall" color={colors.accentInk}>
            {String(count)}
          </AppText>
        </View>
      )}
      {trailing}
      {showChevron && <Icon name="chevron-forward-outline" size={chevronSize} color={colors.meta} />}
    </>
  );

  if (onPress === undefined) {
    return (
      <View accessibilityLabel={accessibilityLabel} style={[styles.row, style]}>
        {content}
      </View>
    );
  }
  return (
    <PressableScale
      scale={pressScale.row}
      haptic={haptic}
      onPress={onPress}
      accessibilityLabel={accessibilityLabel}
      style={[styles.row, style]}
    >
      {content}
    </PressableScale>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap,
    padding,
    borderRadius: radius,
    backgroundColor: colors.surface,
  },
  thumbnail: { width: thumbnailSize, height: thumbnailSize },
  text: { flex: 1, gap: spacing.xs / 2 },
  count: {
    minWidth: countBadgeSize,
    height: countBadgeSize,
    paddingHorizontal: 6,
    borderRadius: countBadgeSize / 2,
    backgroundColor: colors.ink,
    alignItems: 'center',
    justifyContent: 'center',
  },
});
