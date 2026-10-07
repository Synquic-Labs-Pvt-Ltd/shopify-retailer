import { useNavigation, useRoute, type RouteProp } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { StatusBar } from 'expo-status-bar';
import { useMemo, useState } from 'react';
import { FlatList, StyleSheet, View, useWindowDimensions, type NativeScrollEvent, type NativeSyntheticEvent } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useBatch } from '../../api/batches';
import type { MainStackParamList } from '../../app/navigation/types';
import { AppText, InkActivityIndicator, colors, radii, spacing } from '../../design';
import { usableOutputs, type UsableOutput } from './outputs';
import { useDownloads } from './useDownloads';
import { VideoPage } from './VideoPage';
import { ViewerButton } from './ViewerButton';
import { ZoomableImage } from './ZoomableImage';

// SPEC 16.2 MediaViewer: black, swipe between the outputs of one product, "n/N" counter, close, download and
// share. Images zoom, videos loop muted.
export function MediaViewerScreen() {
  const navigation = useNavigation<NativeStackNavigationProp<MainStackParamList, 'MediaViewer'>>();
  const { batchId, itemId, initialMediaId } = useRoute<RouteProp<MainStackParamList, 'MediaViewer'>>().params;
  const insets = useSafeAreaInsets();
  const { width, height } = useWindowDimensions();
  const downloads = useDownloads();
  // The batch is already in the cache from ItemResults; no polling here, so the pages never reshuffle.
  const query = useBatch(batchId, false);

  const outputs = useMemo(() => {
    const item = query.data?.items.find((candidate) => candidate.id === itemId);
    return item === undefined ? [] : usableOutputs(item);
  }, [query.data, itemId]);

  const initialIndex = Math.max(0, outputs.findIndex((media) => media.id === initialMediaId));
  const [pagedIndex, setPagedIndex] = useState<number | null>(null);
  const index = Math.min(pagedIndex ?? initialIndex, Math.max(0, outputs.length - 1));
  const current = outputs[index];

  const onPaged = (event: NativeSyntheticEvent<NativeScrollEvent>) =>
    setPagedIndex(Math.round(event.nativeEvent.contentOffset.x / width));

  const renderPage = ({ item, index: pageIndex }: { item: UsableOutput; index: number }) =>
    item.mediaType === 'video' ? (
      <VideoPage media={item} active={pageIndex === index} width={width} height={height} />
    ) : (
      <ZoomableImage uri={item.url} previewUri={item.previewUrl} width={width} height={height} />
    );

  return (
    <View style={styles.root}>
      <StatusBar style="light" />
      {outputs.length > 0 ? (
        <FlatList
          data={outputs}
          extraData={index}
          horizontal
          pagingEnabled
          showsHorizontalScrollIndicator={false}
          keyExtractor={(media) => media.id}
          renderItem={renderPage}
          initialScrollIndex={initialIndex}
          getItemLayout={(_, pageIndex) => ({ length: width, offset: width * pageIndex, index: pageIndex })}
          onMomentumScrollEnd={onPaged}
          initialNumToRender={1}
          windowSize={3}
        />
      ) : (
        <View style={styles.center}>
          {query.isPending ? (
            <InkActivityIndicator size="large" color={colors.accentInk} />
          ) : (
            <AppText variant="bodyMedium" color={colors.onDarkMuted}>
              Nothing to show.
            </AppText>
          )}
        </View>
      )}

      <View pointerEvents="box-none" style={[styles.topBar, { paddingTop: insets.top + spacing.sm }]}>
        <View style={styles.side}>
          <ViewerButton icon="close-outline" accessibilityLabel="Close" onPress={() => navigation.goBack()} />
        </View>
        {outputs.length > 0 && (
          <View style={styles.counter}>
            <AppText variant="chip" color={colors.accentInk}>{`${index + 1}/${outputs.length}`}</AppText>
          </View>
        )}
        <View style={[styles.side, styles.actions]}>
          {current !== undefined && (
            <>
              <ViewerButton
                icon="download-outline"
                accessibilityLabel="Download to gallery"
                busy={downloads.state.kind === 'saving'}
                onPress={() => void downloads.saveOne(current)}
              />
              <ViewerButton icon="share-outline" accessibilityLabel="Share" onPress={() => void downloads.share(current)} />
            </>
          )}
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.viewerBackground },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  topBar: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: spacing.md,
  },
  side: { flex: 1, flexDirection: 'row' },
  actions: { justifyContent: 'flex-end', gap: spacing.sm },
  counter: {
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm - 2,
    borderRadius: radii.pill,
    backgroundColor: colors.viewerControl,
  },
});
