'use client';

import { useRouter } from 'next/navigation';
import { Fragment, useMemo } from 'react';
import { useDraftSession } from '@/components/products/useDraftSession';
import { allSlotsReady, mergeUnresolved, resolveProducts } from '@/lib/references/resolution';
import { showToast } from '@/lib/shopify';
import { useDraftStore } from '@/lib/state';
import { BlockedUploadBanner } from './BlockedUploadBanner';
import { CommonReferences } from './CommonReferences';
import { GenerateSkeleton } from './GenerateSkeleton';
import { ProductReferenceRow } from './ProductReferenceRow';
import { SummaryAside } from './SummaryAside';
import { canGenerate, generateLabel, processingFailedMessage, slotCounts, unresolvedBanner } from './logic';
import { useDeepLinkProducts } from './useDeepLinkProducts';
import { useGenerate } from './useGenerate';
import { useReferenceActions } from './useReferenceActions';
import { useReferenceProcessing } from './useReferenceProcessing';

// Opens an in-app route without reloading the document, while keeping a real href on the link.
function useInAppLink() {
  const router = useRouter();
  return (href: string) => (event: { preventDefault(): void }) => {
    event.preventDefault();
    router.push(href);
  };
}

// SPEC 16.2 References: common and per-product references, the live resolution and Generate.
export function GenerateView() {
  const { hydrated, me, maxProducts } = useDraftSession();
  const actions = useReferenceActions();
  const generation = useGenerate();
  const link = useInAppLink();
  useReferenceProcessing((count) => showToast(processingFailedMessage(count), true));
  const fetchingDeepLink = useDeepLinkProducts(hydrated && me.data !== undefined, maxProducts);

  const products = useDraftStore((state) => state.products);
  const commonRefs = useDraftStore((state) => state.commonRefs);
  const productRefs = useDraftStore((state) => state.productRefs);
  const draft = useMemo(() => ({ products, commonRefs, productRefs }), [products, commonRefs, productRefs]);
  const resolutions = useMemo(() => resolveProducts(draft), [draft]);
  const counts = useMemo(() => slotCounts(draft), [draft]);

  const unresolvedIds = useMemo(
    () =>
      mergeUnresolved(
        generation.serverGids,
        resolutions.filter((resolution) => resolution.unresolved).map((resolution) => resolution.product.id),
      ),
    [generation.serverGids, resolutions],
  );
  const unresolvedCount = resolutions.filter((resolution) => unresolvedIds.has(resolution.product.id)).length;

  if (!hydrated || generation.leaving || (fetchingDeepLink && !me.isError)) return <GenerateSkeleton />;

  const breadcrumb = (
    <s-link slot="breadcrumb-actions" href="/products" onClick={link('/products')}>
      Products
    </s-link>
  );

  if (products.length === 0) {
    return (
      <s-page heading="New generation">
        {breadcrumb}
        <s-section>
          <s-empty-state heading="No products selected">
            <s-paragraph>Choose the products you want to generate content for.</s-paragraph>
            <s-button slot="primary-action" variant="primary" href="/products" onClick={link('/products')}>
              Select products
            </s-button>
          </s-empty-state>
        </s-section>
      </s-page>
    );
  }

  const canSubmit = canGenerate({
    hydrated,
    submitting: generation.submitting,
    productCount: products.length,
    unresolvedCount,
    slotsReady: allSlotsReady(draft),
  });
  const banner = unresolvedCount > 0 ? unresolvedBanner(unresolvedCount) : null;
  const references = me.data?.generation.references;

  return (
    <s-page heading="New generation">
      {breadcrumb}
      <s-button
        slot="primary-action"
        variant="primary"
        disabled={!canSubmit}
        loading={generation.submitting}
        onClick={() => void generation.generate()}
      >
        {generateLabel(products.length)}
      </s-button>

      {banner !== null ? (
        <s-banner tone="warning" heading={banner.heading}>
          {banner.body}
        </s-banner>
      ) : null}
      {actions.blocked ? <BlockedUploadBanner onDismiss={actions.dismissBlocked} /> : null}
      {me.isError && me.data === undefined ? (
        <s-banner tone="critical" heading="Could not load the generation settings.">
          <s-button slot="secondary-actions" onClick={() => void me.refetch()}>
            Retry
          </s-button>
        </s-banner>
      ) : null}

      <CommonReferences
        references={commonRefs}
        max={references?.maxCommon}
        onFiles={(files) => void actions.add({ kind: 'common' }, files)}
        onRetry={(clientId) => void actions.retry(clientId)}
        onRemove={actions.remove}
      />

      <s-section heading={`Products (${products.length})`} padding="none">
        {resolutions.map((resolution, index) => (
          <Fragment key={resolution.product.id}>
            {index > 0 ? <s-divider /> : null}
            <ProductReferenceRow
              resolution={resolution}
              flaggedByServer={generation.serverGids.includes(resolution.product.id)}
              onFiles={(files) => void actions.add({ kind: 'product', productId: resolution.product.id }, files)}
              onRetry={(clientId) => void actions.retry(clientId)}
              onRemove={actions.remove}
              onRemoveProduct={() => useDraftStore.getState().toggleProduct(resolution.product, maxProducts)}
            />
          </Fragment>
        ))}
      </s-section>

      <SummaryAside
        productCount={products.length}
        imagesPerProduct={me.data?.generation.imagesPerProduct}
        videosPerProduct={me.data?.generation.videosPerProduct}
        readyProducts={products.length - unresolvedCount}
        counts={counts}
      />
    </s-page>
  );
}
