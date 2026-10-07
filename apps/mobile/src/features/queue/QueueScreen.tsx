import { useIsFocused, useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { useCallback, useMemo } from 'react';
import { FlatList, RefreshControl, StyleSheet, View } from 'react-native';
import type { BatchSummary } from '@rs/shared';
import { useBatches } from '../../api/batches';
import type { MainStackParamList } from '../../app/navigation/types';
import {
  Banner,
  EmptyState,
  InkActivityIndicator,
  Screen,
  ScreenHeader,
  Skeleton,
  colors,
  components,
  layout,
  spacing,
} from '../../design';
import { useManualRefresh } from '../common/useManualRefresh';
import { BatchCard } from './BatchCard';

// SPEC 16.2 Queue: batches with progress. Polls every 8 s while any batch is non-terminal.
export function QueueScreen() {
  const navigation = useNavigation<NativeStackNavigationProp<MainStackParamList>>();
  const focused = useIsFocused();
  const query = useBatches(focused);
  const { refreshing, onRefresh } = useManualRefresh(query.refetch);
  const items = useMemo(() => query.data?.pages.flatMap((page) => page.items) ?? [], [query.data]);

  const open = useCallback(
    (batch: BatchSummary) => navigation.navigate('BatchDetail', { batchId: batch.id }),
    [navigation],
  );

  const loadMore = () => {
    if (query.hasNextPage && !query.isFetchingNextPage && !query.isFetchNextPageError) void query.fetchNextPage();
  };

  const empty = query.isPending ? (
    <View style={styles.separated}>
      {[0, 1, 2].map((key) => (
        <View key={key} style={styles.skeletonCard}>
          <Skeleton width={64} height={80} />
          <View style={styles.skeletonText}>
            <Skeleton width="60%" height={16} />
            <Skeleton height={6} />
            <Skeleton width="50%" height={12} />
          </View>
        </View>
      ))}
    </View>
  ) : query.isError ? (
    <Banner
      tone="danger"
      message="Could not load your generations."
      actionLabel="Retry"
      onAction={() => void query.refetch()}
    />
  ) : (
    <EmptyState
      icon="layers-outline"
      title="No generations yet"
      message="Pick products and add references to create your first batch."
      actionLabel="Go to Products"
      onAction={() => navigation.navigate('Tabs', { screen: 'Products' })}
    />
  );

  const listFooter = query.isFetchNextPageError ? (
    <Banner
      tone="danger"
      message="Could not load more generations."
      actionLabel="Retry"
      onAction={() => void query.fetchNextPage()}
    />
  ) : query.isFetchingNextPage ? (
    <View style={styles.loadingMore}>
      <InkActivityIndicator />
    </View>
  ) : null;

  return (
    <Screen>
      <ScreenHeader overline="GENERATIONS" title="Queue" />
      <FlatList
        data={items}
        keyExtractor={(batch) => batch.id}
        renderItem={({ item }) => <BatchCard batch={item} onPress={open} />}
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
        showsVerticalScrollIndicator={false}
        style={styles.list}
        contentContainerStyle={styles.listContent}
      />
    </Screen>
  );
}

function Separator() {
  return <View style={styles.separator} />;
}

const styles = StyleSheet.create({
  list: { flex: 1, marginHorizontal: -layout.screenPaddingX },
  listContent: {
    paddingHorizontal: layout.screenPaddingX,
    paddingTop: spacing.md,
    paddingBottom: layout.tabScreenBottomPaddingMin,
  },
  separator: { height: spacing.sm + spacing.xs },
  separated: { gap: spacing.sm + spacing.xs },
  loadingMore: { paddingVertical: spacing.md },
  skeletonCard: {
    flexDirection: 'row',
    gap: spacing.md,
    padding: components.panel.padding,
    borderRadius: components.panel.radius,
    backgroundColor: colors.surface,
  },
  skeletonText: { flex: 1, justifyContent: 'space-between' },
});
