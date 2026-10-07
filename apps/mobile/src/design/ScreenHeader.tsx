import type { ReactNode } from 'react';
import { StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';
import { AppText } from './AppText';
import { haptics } from './haptics';
import { Icon } from './Icon';
import { PressableScale } from './PressableScale';
import { colors, components, layout, pressScale, spacing } from './theme';

export interface ScreenHeaderProps {
  title: string;
  // Uppercase label above the title.
  overline?: string;
  // Shows the 40 pt white circular back button on its own row.
  onBack?: () => void;
  // Rendered at the right end of the title row (for example a "Select all" action).
  trailing?: ReactNode;
  // Rendered under the title (for example a search Field).
  children?: ReactNode;
  // Long press on the title. Used by the dev-only design gallery entry.
  onTitleLongPress?: () => void;
  style?: StyleProp<ViewStyle>;
}

export function ScreenHeader({ title, overline, onBack, trailing, children, onTitleLongPress, style }: ScreenHeaderProps) {
  return (
    <View style={[styles.root, style]}>
      {onBack !== undefined && (
        <PressableScale
          scale={pressScale.iconButton}
          accessibilityLabel="Go back"
          onPress={onBack}
          style={styles.back}
        >
          <Icon name="chevron-back-outline" size={components.icons.rowMax} />
        </PressableScale>
      )}
      <View style={styles.titleRow}>
        <View style={styles.titles}>
          {overline !== undefined && (
            <AppText variant="sectionLabel" color={colors.meta}>
              {overline}
            </AppText>
          )}
          <AppText
            variant="pageTitle"
            accessibilityRole="header"
            onLongPress={
              onTitleLongPress === undefined
                ? undefined
                : () => {
                    haptics.medium();
                    onTitleLongPress();
                  }
            }
            suppressHighlighting
          >
            {title}
          </AppText>
        </View>
        {trailing}
      </View>
      {children}
    </View>
  );
}

const styles = StyleSheet.create({
  root: { paddingTop: layout.scrollTopPadding, gap: spacing.md },
  back: {
    width: components.screenHeader.backButtonSize,
    height: components.screenHeader.backButtonSize,
    borderRadius: components.screenHeader.backButtonSize / 2,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.surface,
  },
  titleRow: { flexDirection: 'row', alignItems: 'flex-end', justifyContent: 'space-between', gap: spacing.md },
  titles: { flex: 1, gap: spacing.xs },
});
