import { StyleSheet, View } from 'react-native';
import { AppText, Screen, layout, colors, spacing } from '../design';

export interface PlaceholderScreenProps {
  overline?: string;
  title: string;
}

// Phase 0 stand-in for every real screen: the title in design tokens.
export function PlaceholderScreen({ overline, title }: PlaceholderScreenProps) {
  return (
    <Screen>
      <View style={styles.header}>
        {overline !== undefined && (
          <AppText variant="sectionLabel" color={colors.meta}>
            {overline}
          </AppText>
        )}
        <AppText variant="pageTitle">{title}</AppText>
      </View>
    </Screen>
  );
}

const styles = StyleSheet.create({
  header: { paddingTop: layout.scrollTopPadding, gap: spacing.xs },
});
