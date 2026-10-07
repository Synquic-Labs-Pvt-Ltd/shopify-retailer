import { Linking, StyleSheet, View } from 'react-native';
import { KeyboardAwareScrollView } from 'react-native-keyboard-controller';
import { SHOP_DOMAIN_SUFFIX } from '@rs/shared';
import {
  AppText,
  Field,
  PressableScale,
  PrimaryButton,
  Screen,
  colors,
  layout,
  spacing,
  useToast,
} from '../../design';
import { useLogin } from './useLogin';

// Footer links are configured per build. Unset ones say so instead of opening nothing.
const FOOTER_LINKS = [
  { label: 'Privacy', url: process.env.EXPO_PUBLIC_PRIVACY_URL },
  { label: 'Terms', url: process.env.EXPO_PUBLIC_TERMS_URL },
  { label: 'Support', url: process.env.EXPO_PUBLIC_SUPPORT_URL },
] as const;

// SPEC 16.2 Login.
export function LoginScreen() {
  const toast = useToast();
  const { domain, setDomain, fieldError, loading, submit } = useLogin();

  const openLink = (url: string | undefined) => {
    if (url === undefined || url === '') {
      toast.show('This link is not available yet.');
      return;
    }
    Linking.openURL(url).catch(() => toast.error('Could not open the link.'));
  };

  return (
    <Screen>
      <KeyboardAwareScrollView
        keyboardShouldPersistTaps="handled"
        bottomOffset={spacing.lg}
        showsVerticalScrollIndicator={false}
        contentContainerStyle={styles.content}
      >
        <View style={styles.main}>
          <View style={styles.header}>
            <AppText variant="sectionLabel" color={colors.meta}>
              RETAILER STUDIO
            </AppText>
            <AppText variant="hero">Log in</AppText>
            <AppText variant="meta" color={colors.meta}>
              Use your Shopify store account.
            </AppText>
          </View>
          <View style={styles.form}>
            <Field
              label="STORE DOMAIN"
              value={domain}
              onChangeText={setDomain}
              suffix={SHOP_DOMAIN_SUFFIX}
              error={fieldError}
              placeholder="your-store"
              autoCapitalize="none"
              autoCorrect={false}
              autoComplete="off"
              spellCheck={false}
              keyboardType="url"
              returnKeyType="go"
              onSubmitEditing={() => void submit()}
            />
            <PrimaryButton label="Log in with Shopify" loading={loading} onPress={() => void submit()} />
          </View>
        </View>
        <View style={styles.footer}>
          {FOOTER_LINKS.map((link) => (
            <PressableScale key={link.label} onPress={() => openLink(link.url)} accessibilityRole="link">
              <AppText variant="meta" color={colors.meta}>
                {link.label}
              </AppText>
            </PressableScale>
          ))}
        </View>
      </KeyboardAwareScrollView>
    </Screen>
  );
}

const styles = StyleSheet.create({
  content: { flexGrow: 1, justifyContent: 'space-between', paddingBottom: spacing.lg },
  main: { gap: spacing.xl },
  header: { paddingTop: spacing.xxl, gap: spacing.sm },
  form: { gap: spacing.md },
  footer: { flexDirection: 'row', justifyContent: 'center', gap: layout.sectionGapMax, paddingTop: spacing.xl },
});
