import { useIsFocused, useNavigation, useRoute, type RouteProp } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { useCallback } from 'react';
import { Alert, RefreshControl, ScrollView, StyleSheet, View } from 'react-native';
import { isTerminalBatchStatus, type BatchDetail, type BatchItemView } from '@rs/shared';
import { useBatch, useCancelBatch, useRetryFailed } from '../../api/batches';
import { errorMessage } from '../../api/errors';
import type { MainStackParamList } from '../../app/navigation/types';
import {
  AppText,
  Banner,
  PrimaryButton,
  ProgressBar,
  Screen,
  ScreenHeader,
  Skeleton,
  StatusChip,
  StickyFooter,
  colors,
  layout,
  spacing,
  useToast,
} from '../../design';
import { useManualRefresh } from '../common/useManualRefresh';
import { BatchItemRow } from './BatchItemRow';
import { clockTime, plural } from './format';
import { batchLabel, batchProgress, batchTone, delayMessage } from './status';

function expectedOutputs(batch: BatchDetail): number {
  const { imagesPerProduct, videosPerProduct } = batch.configSnapshot.outputs;
  return imagesPerProduct + videosPerProduct;
}

// SPEC 16.2 BatchDetail: items with their outputs as they arrive, polled every 4 s until the batch ends.
export function BatchDetailScreen() {
  const navigation = useNavigation<NativeStackNavigationProp<MainStackParamList, 'BatchDetail'>>();
  const { batchId } = useRoute<RouteProp<MainStackParamList, 'BatchDetail'>>().params;
  const toast = useToast();
  const focused = useIsFocused();
  const query = useBatch(batchId, focused);
  const cancel = useCancelBatch();
  const retry = useRetryFailed();
  const { refreshing, onRefresh } = useManualRefresh(query.refetch);
  const batch = query.data;

  const openItem = useCallback(
    (item: BatchItemView) => navigation.navigate('ItemResults', { batchId, itemId: item.id }),
    [navigation, batchId],
  );

  const confirmCancel = () => {
    Alert.alert(
      'Cancel this generation?',
      'Jobs that are already running finish and keep their output. Everything else is cancelled.',
      [
        { text: 'Keep running', style: 'cancel' },
        {
          text: 'Cancel generation',
          style: 'destructive',
          onPress: () =>
            cancel.mutate(batchId, {
              onSuccess: () => toast.show('Generation cancelled'),
              onError: (error) => toast.error(errorMessage(error, 'Could not cancel the generation.')),
            }),
        },
      ],
    );
  };

  const retryFailed = () =>
    retry.mutate(batchId, {
      onSuccess: () => toast.success('Retrying the failed jobs'),
      onError: (error) => toast.error(errorMessage(error, 'Could not retry the failed jobs.')),
    });

  const terminal = batch !== undefined && isTerminalBatchStatus(batch.status);
  const showRetry = batch !== undefined && terminal && batch.counts.jobsFailed > 0;
  const showCancel = batch !== undefined && !terminal;

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
        <ScreenHeader
          overline="BATCH"
          title={batch === undefined ? 'Generation' : plural(batch.counts.products, 'product')}
          onBack={() => navigation.goBack()}
        />

        {batch === undefined ? (
          query.isError ? (
            <Banner
              tone="danger"
              message="Could not load this generation."
              actionLabel="Retry"
              onAction={() => void query.refetch()}
            />
          ) : (
            <Skeletons />
          )
        ) : (
          <>
            <View style={styles.summary}>
              <StatusChip label={batchLabel(batch.status)} tone={batchTone(batch.status)} />
              <ProgressBar progress={batchProgress(batch.counts)} />
              <AppText variant="meta" color={colors.meta}>
                {`${plural(batch.counts.imagesReady, 'image')} · ${plural(batch.counts.videosReady, 'video')} ready`}
              </AppText>
            </View>

            {batch.delay !== null && (
              <Banner
                tone="warning"
                icon="time-outline"
                title="Generation is delayed"
                message={delayMessage(batch.delay.reason, clockTime(batch.delay.resumesAt))}
              />
            )}

            <View style={styles.items}>
              {batch.items.map((item) => (
                <BatchItemRow key={item.id} item={item} expectedOutputs={expectedOutputs(batch)} onPress={openItem} />
              ))}
            </View>
          </>
        )}
      </ScrollView>

      {(showCancel || showRetry) && (
        <StickyFooter>
          {showCancel && (
            <PrimaryButton label="Cancel" tone="ghost" loading={cancel.isPending} onPress={confirmCancel} />
          )}
          {showRetry && <PrimaryButton label="Retry failed" loading={retry.isPending} onPress={retryFailed} />}
        </StickyFooter>
      )}
    </Screen>
  );
}

function Skeletons() {
  return (
    <View style={styles.items}>
      <Skeleton height={6} />
      {[0, 1, 2].map((key) => (
        <Skeleton key={key} height={150} radius={18} />
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  content: { paddingBottom: spacing.lg, gap: layout.sectionGapMin },
  summary: { gap: spacing.sm + spacing.xs },
  items: { gap: spacing.sm + spacing.xs },
});
