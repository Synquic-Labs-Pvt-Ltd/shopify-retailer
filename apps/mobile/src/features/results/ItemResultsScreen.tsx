import { useIsFocused, useNavigation, useRoute, type RouteProp } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { useCallback, useMemo } from 'react';
import { RefreshControl, ScrollView, StyleSheet, View, useWindowDimensions } from 'react-native';
import type { MediaObject } from '@rs/shared';
import { useBatch } from '../../api/batches';
import type { MainStackParamList } from '../../app/navigation/types';
import {
  Banner,
  EmptyState,
  PrimaryButton,
  Screen,
  ScreenHeader,
  Skeleton,
  StickyFooter,
  colors,
  layout,
  radii,
  components,
  spacing,
} from '../../design';
import { useManualRefresh } from '../common/useManualRefresh';
import { errorCodeText, resultTiles, usableOutputs } from './outputs';
import { FailedTile, OutputTile, PendingTile } from './ResultTile';
import { useDownloads } from './useDownloads';

// SPEC 16.2 ItemResults: a 2-column grid of 3:4 tiles with a sticky "Download all".
export function ItemResultsScreen() {
  const navigation = useNavigation<NativeStackNavigationProp<MainStackParamList, 'ItemResults'>>();
  const { batchId, itemId } = useRoute<RouteProp<MainStackParamList, 'ItemResults'>>().params;
  const focused = useIsFocused();
  const query = useBatch(batchId, focused);
  const { refreshing, onRefresh } = useManualRefresh(query.refetch);
  const downloads = useDownloads();
  const { width } = useWindowDimensions();

  const item = query.data?.items.find((candidate) => candidate.id === itemId);
  const tiles = useMemo(() => (item === undefined ? [] : resultTiles(item)), [item]);
  const outputs = useMemo(() => (item === undefined ? [] : usableOutputs(item)), [item]);
  const tileWidth = Math.floor((width - 2 * layout.screenPaddingX - layout.gridGap) / 2);

  const openViewer = useCallback(
    (media: MediaObject) => navigation.navigate('MediaViewer', { batchId, itemId, initialMediaId: media.id }),
    [navigation, batchId, itemId],
  );

  const saving = downloads.state.kind === 'saving';
  const downloadLabel =
    downloads.state.kind === 'saving'
      ? `Saving ${downloads.state.current} of ${downloads.state.total}`
      : 'Download all';

  return (
    <Screen>
      <ScrollView
        showsVerticalScrollIndicator={false}
        contentContainerStyle={styles.content}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={onRefresh}
            tintColor={colors.ink}
            colors={[colors.ink]}
          />
        }
      >
        <ScreenHeader overline="RESULTS" title={item?.title ?? 'Results'} onBack={() => navigation.goBack()} />

        {item === undefined ? (
          query.isError ? (
            <Banner
              tone="danger"
              message="Could not load the results."
              actionLabel="Retry"
              onAction={() => void query.refetch()}
            />
          ) : query.isPending ? (
            <View style={styles.grid}>
              {[0, 1, 2, 3].map((key) => (
                <View key={key} style={{ width: tileWidth, aspectRatio: components.image.outputAspectRatio }}>
                  <Skeleton width="100%" height="100%" radius={radii.card} />
                </View>
              ))}
            </View>
          ) : (
            <EmptyState
              icon="images-outline"
              title="Product not found"
              message="It may have been removed from this batch."
            />
          )
        ) : tiles.length === 0 ? (
          <EmptyState
            icon="images-outline"
            title="No outputs yet"
            message="Outputs appear here as soon as they are generated."
          />
        ) : (
          <View style={styles.grid}>
            {tiles.map((tile) => {
              switch (tile.kind) {
                case 'output':
                  return <OutputTile key={tile.media.id} media={tile.media} width={tileWidth} onPress={openViewer} />;
                case 'pending':
                  return <PendingTile key={tile.key} width={tileWidth} />;
                case 'failed':
                  return (
                    <FailedTile
                      key={tile.key}
                      width={tileWidth}
                      isVideo={tile.jobType === 'video'}
                      codeText={errorCodeText(tile.errorCode)}
                    />
                  );
              }
            })}
          </View>
        )}
      </ScrollView>

      <StickyFooter>
        <PrimaryButton
          label={downloadLabel}
          disabled={outputs.length === 0 || saving}
          onPress={() => void downloads.saveAll(outputs)}
        />
      </StickyFooter>
    </Screen>
  );
}

const styles = StyleSheet.create({
  content: { paddingBottom: spacing.lg, gap: layout.sectionGapMax },
  grid: { flexDirection: 'row', flexWrap: 'wrap', gap: layout.gridGap },
});
