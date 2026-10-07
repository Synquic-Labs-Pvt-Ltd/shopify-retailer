import { StyleSheet, View } from 'react-native';
import { mockSession } from '../../api/mock';
import { API_MOCK } from '../../api/client';
import { AppText, PressableScale, Screen, colors, radii, spacing } from '../../design';
import { useAuthStore } from '../../state/auth';

// Placeholder. The real login (shop domain field, browser auth session, PKCE) is the auth feature.
export function LoginScreen() {
  const setSession = useAuthStore((state) => state.setSession);

  return (
    <Screen>
      <View style={styles.header}>
        <AppText variant="sectionLabel" color={colors.meta}>
          RETAILER STUDIO
        </AppText>
        <AppText variant="hero">Log in</AppText>
        <AppText variant="meta" color={colors.meta}>
          Use your Shopify store account.
        </AppText>
      </View>
      {API_MOCK && (
        <PressableScale haptic="success" style={styles.mockButton} onPress={() => setSession(mockSession())}>
          <AppText variant="button" color={colors.accentInk}>
            Continue with mock session
          </AppText>
        </PressableScale>
      )}
    </Screen>
  );
}

const styles = StyleSheet.create({
  header: { paddingTop: spacing.xxl, gap: spacing.sm },
  mockButton: {
    marginTop: spacing.xl,
    alignItems: 'center',
    padding: spacing.md,
    borderRadius: radii.pill,
    backgroundColor: colors.accent,
  },
});
