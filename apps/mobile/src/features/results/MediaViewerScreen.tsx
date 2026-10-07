import { StyleSheet, View } from 'react-native';
import { AppText, colors, spacing } from '../../design';

export function MediaViewerScreen() {
  return (
    <View style={styles.root}>
      <AppText variant="pageTitle" color={colors.accentInk}>
        Media viewer
      </AppText>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.viewerBackground, padding: spacing.lg },
});
