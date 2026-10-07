import { CommonActions, useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { useEffect, useMemo, useState } from 'react';
import { Platform, ScrollView, StyleSheet, View } from 'react-native';
import { errorMessage, unresolvedProductGids } from '../../api/errors';
import { useCreateBatch } from '../../api/batches';
import { useMe } from '../../api/me';
import type { MainStackParamList } from '../../app/navigation/types';
import {
  AppText,
  Banner,
  EmptyState,
  PrimaryButton,
  Screen,
  ScreenHeader,
  Skeleton,
  StickyFooter,
  colors,
  layout,
  spacing,
  useToast,
} from '../../design';
import { useDraftStore } from '../../state/draft';
import { CommonReferencesPanel } from './CommonReferencesPanel';
import { ProductReferenceCard } from './ProductReferenceCard';
import type { PickSource } from './pickers';
import { allSlotsReady, buildBatchRequest, resolveProducts, unresolvedMessage } from './resolution';
import { SourceSheet } from './SourceSheet';
import { useReferenceActions, type ReferenceTarget } from './useReferenceActions';
import { useReferenceProcessing } from './useReferenceProcessing';

// iOS cannot present the picker while the sheet's modal is still dismissing.
const PICKER_DELAY_MS = Platform.OS === 'ios' ? 400 : 0;

function outputsLine(images: number, videos: number): string {
  const imageText = `${images} ${images === 1 ? 'image' : 'images'}`;
  const videoText = `${videos} ${videos === 1 ? 'video' : 'videos'}`;
  return `Each product gets ${imageText} and ${videoText}.`;
}

// SPEC 16.2 References: common and per-product references, live resolution and Generate.
export function ReferencesScreen() {
  const navigation = useNavigation<NativeStackNavigationProp<MainStackParamList, 'References'>>();
  const toast = useToast();
  const me = useMe();
  const createBatch = useCreateBatch();
  const actions = useReferenceActions();

  const products = useDraftStore((state) => state.products);
  const commonRefs = useDraftStore((state) => state.commonRefs);
  const productRefs = useDraftStore((state) => state.productRefs);

  const [sheetTarget, setSheetTarget] = useState<ReferenceTarget | null>(null);
  const [serverUnresolved, setServerUnresolved] = useState<string[]>([]);

  useReferenceProcessing((count) =>
    toast.error(count === 1 ? 'A reference failed. Tap it to retry.' : `${count} references failed. Tap one to retry.`),
  );

  // A 422 names products the server could not resolve; any change to the draft supersedes it.
  useEffect(() => {
    setServerUnresolved((current) => (current.length === 0 ? current : []));
  }, [commonRefs, productRefs]);

  const resolutions = useMemo(
    () => resolveProducts(products, productRefs, commonRefs),
    [products, productRefs, commonRefs],
  );
  const unresolvedIds = useMemo(() => {
    const ids = new Set(serverUnresolved);
    for (const item of resolutions) if (item.unresolved) ids.add(item.product.id);
    return ids;
  }, [resolutions, serverUnresolved]);
  const slotsReady = allSlotsReady(products, productRefs, commonRefs);
  const canGenerate = products.length > 0 && unresolvedIds.size === 0 && slotsReady;

  const openSheet = (target: ReferenceTarget) => setSheetTarget(target);
  const closeSheet = () => setSheetTarget(null);

  const pickFrom = (source: PickSource) => {
    const target = sheetTarget;
    setSheetTarget(null);
    if (target === null) return;
    setTimeout(() => void actions.add(source, target), PICKER_DELAY_MS);
  };

  const generate = async () => {
    const draft = useDraftStore.getState();
    try {
      const batch = await createBatch.mutateAsync(
        buildBatchRequest(draft.idempotencyKey, draft.products, draft.productRefs, draft.commonRefs),
      );
      toast.success('Generation queued');
      navigation.dispatch(
        CommonActions.reset({
          index: 1,
          routes: [
            { name: 'Tabs', params: { screen: 'Queue' } },
            { name: 'BatchDetail', params: { batchId: batch.id } },
          ],
        }),
      );
      useDraftStore.getState().reset();
    } catch (error) {
      const gids = unresolvedProductGids(error);
      if (gids !== null) setServerUnresolved(gids);
      toast.error(errorMessage(error, 'Could not queue the generation. Try again.'));
    }
  };

  const sheetTitle =
    sheetTarget?.kind === 'product'
      ? (products.find((product) => product.id === sheetTarget.productId)?.title ?? 'Add references')
      : 'Common references';
  const generation = me.data?.generation;

  return (
    <Screen>
      <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={styles.content}>
        <ScreenHeader
          overline="NEW GENERATION · STEP 2"
          title="Add references"
          onBack={() => navigation.goBack()}
        >
          {generation !== undefined ? (
            <AppText variant="meta" color={colors.meta}>
              {outputsLine(generation.imagesPerProduct, generation.videosPerProduct)}
            </AppText>
          ) : me.isError ? (
            <Banner
              tone="danger"
              message="Could not load the generation settings."
              actionLabel="Retry"
              onAction={() => void me.refetch()}
            />
          ) : (
            <Skeleton width="70%" height={16} />
          )}
        </ScreenHeader>

        {products.length === 0 ? (
          <EmptyState
            icon="pricetags-outline"
            title="No products selected"
            message="Choose the products to generate for."
            actionLabel="Back to products"
            onAction={() => navigation.goBack()}
          />
        ) : (
          <>
            {unresolvedIds.size > 0 && <Banner tone="warning" message={unresolvedMessage(unresolvedIds.size)} />}

            <CommonReferencesPanel
              refs={commonRefs}
              onAdd={() => openSheet({ kind: 'common' })}
              onRetry={(clientId) => void actions.retry(clientId)}
              onRemove={actions.remove}
            />

            <View style={styles.section}>
              <AppText variant="sectionLabel" color={colors.meta}>
                {`PRODUCTS (${products.length})`}
              </AppText>
              {resolutions.map((resolution) => (
                <ProductReferenceCard
                  key={resolution.product.id}
                  resolution={resolution}
                  unresolved={unresolvedIds.has(resolution.product.id)}
                  onAdd={() => openSheet({ kind: 'product', productId: resolution.product.id })}
                  onRetry={(clientId) => void actions.retry(clientId)}
                  onRemove={actions.remove}
                />
              ))}
            </View>
          </>
        )}
      </ScrollView>

      {products.length > 0 && (
        <StickyFooter>
          <PrimaryButton
            label={`Generate ${products.length} ${products.length === 1 ? 'product' : 'products'}`}
            disabled={!canGenerate}
            loading={createBatch.isPending}
            onPress={() => void generate()}
          />
        </StickyFooter>
      )}

      <SourceSheet visible={sheetTarget !== null} title={sheetTitle} onClose={closeSheet} onSelect={pickFrom} />
    </Screen>
  );
}

const styles = StyleSheet.create({
  content: { paddingBottom: spacing.lg, gap: layout.sectionGapMax },
  section: { gap: layout.sectionGapMin },
});
