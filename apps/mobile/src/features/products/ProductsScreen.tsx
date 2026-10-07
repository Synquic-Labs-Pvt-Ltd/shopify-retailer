import { useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { FlatList, Keyboard, RefreshControl, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { ProductListItem } from '@rs/shared';
import { useMe } from '../../api/me';
import { useProducts } from '../../api/products';
import type { MainStackParamList } from '../../app/navigation/types';
import {
  AppText,
  Banner,
  EmptyState,
  Field,
  InkActivityIndicator,
  PressableScale,
  PrimaryButton,
  Screen,
  ScreenHeader,
  StickyFooter,
  colors,
  layout,
  spacing,
  useToast,
} from '../../design';
import { useAuthStore } from '../../state/auth';
import { useDraftHydrated, useDraftStore, type DraftProduct } from '../../state/draft';
import { useManualRefresh } from '../common/useManualRefresh';
import { ProductListSkeleton } from './ProductListSkeleton';
import { ProductRow } from './ProductRow';
import { tabBarClearance } from './layout';
import { useDebouncedValue } from './useDebouncedValue';

const DEFAULT_MAX_PRODUCTS = 50;
const SEARCH_DEBOUNCE_MS = 350;

function toDraftProduct(item: ProductListItem): DraftProduct {
  return { id: item.id, title: item.title, imageUrl: item.imageUrl };
}

// SPEC 16.2 Products: search, infinite scroll, single and bulk selection kept in the persisted draft.
export function ProductsScreen() {
  const navigation = useNavigation<NativeStackNavigationProp<MainStackParamList>>();
  const toast = useToast();
  const insets = useSafeAreaInsets();
  const maxProducts = useMe().data?.generation.maxProductsPerBatch ?? DEFAULT_MAX_PRODUCTS;

  const [search, setSearch] = useState('');
  const debouncedSearch = useDebouncedValue(search, SEARCH_DEBOUNCE_MS);
  const query = useProducts(debouncedSearch);
  const { refreshing, onRefresh } = useManualRefresh(query.refetch);

  const selection = useDraftStore((state) => state.products);
  const selectedIds = useMemo(() => new Set(selection.map((product) => product.id)), [selection]);
  const items = useMemo(() => query.data?.pages.flatMap((page) => page.items) ?? [], [query.data]);

  // A draft never carries over to another shop's session.
  const hydrated = useDraftHydrated();
  const shopId = useAuthStore((state) => state.session?.shop.id);
  useEffect(() => {
    if (hydrated && shopId !== undefined) useDraftStore.getState().bindShop(shopId);
  }, [hydrated, shopId]);

  const toggle = useCallback(
    (item: ProductListItem) => {
      Keyboard.dismiss();
      const draft = useDraftStore.getState();
      const selected = draft.products.some((product) => product.id === item.id);
      if (!selected && draft.products.length >= maxProducts) {
        toast.error(`You can select up to ${maxProducts} products.`);
        return;
      }
      draft.toggleProduct(toDraftProduct(item));
    },
    [maxProducts, toast],
  );

  const allSelected = items.length > 0 && items.every((item) => selectedIds.has(item.id));
  const showClear = allSelected || selection.length >= maxProducts;

  const toggleAll = () => {
    const draft = useDraftStore.getState();
    if (showClear) {
      draft.setProducts([]);
      return;
    }
    const missing = items.filter((item) => !selectedIds.has(item.id));
    const added = missing.slice(0, Math.max(0, maxProducts - draft.products.length));
    draft.setProducts([...draft.products, ...added.map(toDraftProduct)]);
    if (added.length < missing.length) toast.show(`Selection is limited to ${maxProducts} products.`);
  };

  const loadMore = () => {
    if (query.hasNextPage && !query.isFetchingNextPage && !query.isFetchNextPageError) void query.fetchNextPage();
  };

  const hasSelection = selection.length > 0;
  const searching = debouncedSearch.trim() !== '';

  const empty = query.isPending ? (
    <ProductListSkeleton />
  ) : query.isError ? (
    <Banner
      tone="danger"
      message="Could not load your products."
      actionLabel="Retry"
      onAction={() => void query.refetch()}
    />
  ) : (
    <EmptyState
      icon="pricetags-outline"
      title="No products found"
      message={searching ? 'Try a different search.' : 'Products appear here once your store has some.'}
    />
  );

  const listFooter = query.isFetchNextPageError ? (
    <Banner
      tone="danger"
      message="Could not load more products."
      actionLabel="Retry"
      onAction={() => void query.fetchNextPage()}
      style={styles.footerBanner}
    />
  ) : query.isFetchingNextPage ? (
    <View style={styles.loadingMore}>
      <InkActivityIndicator />
    </View>
  ) : null;

  return (
    <Screen>
      <ScreenHeader
        overline="STORE CATALOG"
        title="Products"
        trailing={
          items.length > 0 ? (
            <PressableScale
              haptic="selection"
              onPress={toggleAll}
              accessibilityLabel={showClear ? 'Clear selection' : 'Select all'}
            >
              <AppText variant="navLabelHeader">{showClear ? 'Clear' : 'Select all'}</AppText>
            </PressableScale>
          ) : undefined
        }
      >
        <Field
          icon="search-outline"
          placeholder="Search products"
          value={search}
          onChangeText={setSearch}
          returnKeyType="search"
          autoCapitalize="none"
          autoCorrect={false}
          accessibilityLabel="Search products"
        />
      </ScreenHeader>

      <FlatList
        data={items}
        extraData={selectedIds}
        keyExtractor={(item) => item.id}
        renderItem={({ item }) => <ProductRow product={item} selected={selectedIds.has(item.id)} onToggle={toggle} />}
        ItemSeparatorComponent={Separator}
        ListEmptyComponent={empty}
        ListFooterComponent={listFooter}
        onEndReached={loadMore}
        onEndReachedThreshold={0.6}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={onRefresh}
            tintColor={colors.ink}
            colors={[colors.ink]}
          />
        }
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="on-drag"
        showsVerticalScrollIndicator={false}
        style={styles.list}
        contentContainerStyle={[
          styles.listContent,
          { paddingBottom: hasSelection ? spacing.md : layout.tabScreenBottomPaddingMin },
        ]}
      />

      {hasSelection && (
        <View style={{ marginBottom: tabBarClearance(insets.bottom) }}>
          <StickyFooter followKeyboard={false}>
            <View style={styles.footerRow}>
              <AppText variant="meta" color={colors.meta}>{`${selection.length} selected`}</AppText>
              <PrimaryButton
                label="Continue"
                style={styles.continue}
                onPress={() => navigation.navigate('References')}
              />
            </View>
          </StickyFooter>
        </View>
      )}
    </Screen>
  );
}

function Separator() {
  return <View style={styles.separator} />;
}

const styles = StyleSheet.create({
  list: { flex: 1, marginHorizontal: -layout.screenPaddingX },
  listContent: { paddingHorizontal: layout.screenPaddingX, paddingTop: spacing.md },
  separator: { height: spacing.sm },
  loadingMore: { paddingVertical: spacing.md },
  footerBanner: { marginTop: spacing.sm },
  footerRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.md },
  continue: { flex: 1 },
});
