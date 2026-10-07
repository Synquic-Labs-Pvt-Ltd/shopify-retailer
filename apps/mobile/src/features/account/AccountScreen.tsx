import { useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { useState } from 'react';
import { ScrollView, StyleSheet, View } from 'react-native';
import { useMe } from '../../api/me';
import type { MainStackParamList } from '../../app/navigation/types';
import {
  AppText,
  Banner,
  ListRow,
  Panel,
  PrimaryButton,
  Screen,
  ScreenHeader,
  Skeleton,
  StatusChip,
  colors,
  layout,
  spacing,
} from '../../design';
import { useAuthStore } from '../../state/auth';
import { signOut } from '../auth/authService';

const AVATAR_SIZE = 56;

function initialOf(name: string): string {
  return (name.trim().charAt(0) || '?').toUpperCase();
}

function DetailRow({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.detail}>
      <AppText variant="sectionLabel" color={colors.meta}>
        {label}
      </AppText>
      <AppText variant="bodyMedium">{value}</AppText>
    </View>
  );
}

// SPEC 16.2 Account. Long-pressing the title opens the design gallery in development builds.
export function AccountScreen() {
  const navigation = useNavigation<NativeStackNavigationProp<MainStackParamList>>();
  const session = useAuthStore((state) => state.session);
  const me = useMe();
  const [loggingOut, setLoggingOut] = useState(false);

  const user = me.data?.user ?? session?.user;
  const shop = me.data?.shop ?? session?.shop;
  const generation = me.data?.generation;
  const displayName =
    [user?.firstName, user?.lastName].filter((part) => part !== null && part !== undefined && part !== '').join(' ') ||
    user?.email ||
    shop?.name ||
    'Account';

  const logOut = async () => {
    setLoggingOut(true);
    try {
      await signOut();
    } finally {
      setLoggingOut(false);
    }
  };

  return (
    <Screen>
      <ScrollView
        showsVerticalScrollIndicator={false}
        contentContainerStyle={styles.content}
      >
        <ScreenHeader
          title="Account"
          onTitleLongPress={__DEV__ ? () => navigation.navigate('DesignGallery') : undefined}
        />

        <View style={styles.identity}>
          <View style={styles.avatar}>
            <AppText variant="pageTitle" color={colors.accentInk}>
              {initialOf(displayName)}
            </AppText>
          </View>
          <View style={styles.identityText}>
            <AppText variant="sheetTitle" numberOfLines={1}>
              {displayName}
            </AppText>
            <StatusChip label="Connected" tone="success" />
          </View>
        </View>

        <Panel style={styles.details}>
          <DetailRow label="STORE" value={shop?.name ?? '-'} />
          <View style={styles.divider} />
          <DetailRow label="DOMAIN" value={shop?.domain ?? '-'} />
          <View style={styles.divider} />
          <DetailRow label="EMAIL" value={user?.email ?? '-'} />
        </Panel>

        <View style={styles.section}>
          <AppText variant="sectionLabel" color={colors.meta}>
            GENERATION
          </AppText>
          {me.isError && generation === undefined ? (
            <Banner
              tone="danger"
              message="Could not load the generation settings."
              actionLabel="Retry"
              onAction={() => void me.refetch()}
            />
          ) : (
            <View style={styles.rows}>
              <ListRow
                label="Images per product"
                trailing={<GenerationValue value={generation?.imagesPerProduct} />}
              />
              <ListRow
                label="Videos per product"
                trailing={<GenerationValue value={generation?.videosPerProduct} />}
              />
            </View>
          )}
        </View>

        <PrimaryButton label="Log out" tone="ghost" loading={loggingOut} onPress={() => void logOut()} />
      </ScrollView>
    </Screen>
  );
}

function GenerationValue({ value }: { value: number | undefined }) {
  if (value === undefined) return <Skeleton width={24} height={20} />;
  return <AppText variant="cardTitle">{String(value)}</AppText>;
}

const styles = StyleSheet.create({
  content: {
    paddingBottom: layout.tabScreenBottomPaddingMin,
    gap: layout.sectionGapMax,
  },
  identity: { flexDirection: 'row', alignItems: 'center', gap: spacing.md },
  avatar: {
    width: AVATAR_SIZE,
    height: AVATAR_SIZE,
    borderRadius: AVATAR_SIZE / 2,
    backgroundColor: colors.ink,
    alignItems: 'center',
    justifyContent: 'center',
  },
  identityText: { flex: 1, gap: spacing.xs + 2 },
  details: { gap: spacing.md },
  detail: { gap: spacing.xs },
  divider: { height: 1, backgroundColor: colors.hairline },
  section: { gap: spacing.sm + spacing.xs },
  rows: { gap: spacing.sm },
});
