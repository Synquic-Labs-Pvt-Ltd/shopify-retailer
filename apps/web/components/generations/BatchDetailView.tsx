'use client';

import { useCallback, useMemo, useState } from 'react';
import { errorMessage } from '@/lib/api/errors';
import { pollNotice, useAttachMedia, useBatch, useCancelBatch, useRetryFailed } from '@/lib/api/hooks';
import { batchArchiveName, productArchiveName } from '@/lib/archive';
import { plural, relativeTime } from '@/lib/batch/format';
import { showToast } from '@/lib/shopify';
import {
  BATCH_ATTACHED_LABEL,
  BATCH_ATTACH_LABEL,
  attachErrorNotice,
  attachNotice,
  attachToast,
  attachableItems,
  batchAttachState,
  titleResolver,
  type AttachNotice,
} from './attach';
import { ATTACH_MODAL_ID, AttachModal } from './AttachModal';
import { CANCEL_MODAL_ID, CancelModal } from './CancelModal';
import { ConnectionNotice } from './ConnectionNotice';
import { DelayBanner } from './DelayBanner';
import { ItemSection } from './ItemSection';
import {
  canCancelBatch,
  canRetryFailed,
  batchArchiveFiles,
  isBatchNotFound,
  isValidBatchId,
  outputsPerProduct,
  productArchiveFiles,
  zipProgressOf,
  BATCH_SCOPE,
  type ViewerTarget,
} from './logic';
import { MediaViewer } from './MediaViewer';
import { NoticeBanner } from './NoticeBanner';
import { BatchStatusBadge } from './StatusBadge';
import { SummarySection } from './SummarySection';
import { useDownloads } from './useDownloads';

function BackLink() {
  return (
    <s-link slot="breadcrumb-actions" href="/generations">
      Generations
    </s-link>
  );
}

function NotFound() {
  return (
    <s-page heading="Generation">
      <BackLink />
      <s-banner tone="critical" heading="Generation not found">
        This generation does not exist or was removed.
        <s-button slot="secondary-actions" href="/generations">
          Back to generations
        </s-button>
      </s-banner>
    </s-page>
  );
}

function LoadFailed({ error, onRetry }: { error: unknown; onRetry: () => void }) {
  return (
    <s-page heading="Generation">
      <BackLink />
      <s-banner tone="critical" heading="Could not load this generation">
        {errorMessage(error)}
        <s-button slot="secondary-actions" onClick={onRetry}>
          Retry
        </s-button>
      </s-banner>
    </s-page>
  );
}

function Loading() {
  return (
    <s-page heading="Generation">
      <BackLink />
      <s-section>
        <s-stack alignItems="center" justifyContent="center">
          <s-spinner size="large" accessibilityLabel="Loading generation" />
        </s-stack>
      </s-section>
    </s-page>
  );
}

// SPEC 16.2 BatchDetail and ItemResults: every product with its outputs as they arrive, polled until the batch
// ends. Outputs open in the media viewer; "Download all (.zip)" saves every ready output in one zip with a folder per
// product, and "Add to products" puts the ready outputs on their products in the Shopify store.
export function BatchDetailView({ id }: { id: string }) {
  const validId = isValidBatchId(id);
  const query = useBatch(validId ? id : '');
  const cancel = useCancelBatch();
  const retry = useRetryFailed();
  const attach = useAttachMedia();
  const downloads = useDownloads();
  const [target, setTarget] = useState<ViewerTarget | null>(null);
  // What the running add request is for: BATCH_SCOPE, or the id of one product.
  const [attaching, setAttaching] = useState<string | null>(null);
  const [attachBanner, setAttachBanner] = useState<AttachNotice | null>(null);
  const batch = query.data;

  const { saveArchive } = downloads;
  const archiveFiles = useMemo(() => (batch === undefined ? [] : batchArchiveFiles(batch)), [batch]);
  const viewerItem = useMemo(
    () => (target === null ? undefined : batch?.items.find((candidate) => candidate.id === target.itemId)),
    [batch, target],
  );

  const closeViewer = useCallback(() => setTarget(null), []);
  const selectOutput = useCallback(
    (mediaId: string) => setTarget((current) => (current === null ? null : { ...current, mediaId })),
    [],
  );
  const downloadAll = useCallback(
    () => void saveArchive(BATCH_SCOPE, archiveFiles, batchArchiveName(id)),
    [saveArchive, archiveFiles, id],
  );
  const dismissAttachBanner = useCallback(() => setAttachBanner(null), []);

  if (!validId || (batch === undefined && query.isError && isBatchNotFound(query.error))) return <NotFound />;
  if (batch === undefined) {
    return query.isError ? <LoadFailed error={query.error} onRetry={() => void query.refetch()} /> : <Loading />;
  }

  const cancelBatch = () =>
    cancel.mutate(id, {
      onSuccess: () => showToast('Generation cancelled'),
      onError: (error) => showToast(errorMessage(error, 'Could not cancel the generation.'), true),
    });
  const retryFailed = () =>
    retry.mutate(id, {
      onSuccess: () => showToast('Retrying the failed jobs'),
      onError: (error) => showToast(errorMessage(error, 'Could not retry the failed jobs.'), true),
    });

  // Adds the ready outputs of the given products to their Shopify products.
  const attachMedia = (scope: string, itemIds: string[]) => {
    const titleOf = titleResolver(batch);
    setAttaching(scope);
    setAttachBanner(null);
    attach.mutate(
      { id, itemIds },
      {
        onSuccess: (response) => {
          const toast = attachToast(response, titleOf);
          showToast(toast.message, toast.isError);
          setAttachBanner(attachNotice(response, titleOf));
        },
        onError: (error) => {
          showToast(errorMessage(error, 'Could not add the outputs to the products.'), true);
          setAttachBanner(attachErrorNotice(error));
        },
        onSettled: () => setAttaching(null),
      },
    );
  };

  const connection = pollNotice({ hasData: true, error: query.error, failureReason: query.failureReason });
  const expected = outputsPerProduct(batch);
  const attachable = attachableItems(batch);
  const batchAttach = batchAttachState(batch);
  const working = downloads.saving || attaching !== null;
  const startedText =
    batch.finishedAt === null
      ? `Started ${relativeTime(batch.createdAt)}`
      : `Finished ${relativeTime(batch.finishedAt)}`;

  return (
    <>
      <s-page heading={plural(batch.counts.products, 'product')}>
        <BackLink />
        {canCancelBatch(batch) ? (
          <s-button slot="secondary-actions" commandFor={CANCEL_MODAL_ID} command="--show" loading={cancel.isPending}>
            Cancel
          </s-button>
        ) : null}
        {canRetryFailed(batch) ? (
          <s-button slot="secondary-actions" loading={retry.isPending} onClick={retryFailed}>
            Retry failed
          </s-button>
        ) : null}
        {batchAttach === 'none' ? null : (
          <s-button
            slot="secondary-actions"
            commandFor={ATTACH_MODAL_ID}
            command="--show"
            loading={attaching === BATCH_SCOPE}
            disabled={batchAttach === 'done' || working}
          >
            {batchAttach === 'done' ? BATCH_ATTACHED_LABEL : BATCH_ATTACH_LABEL}
          </s-button>
        )}

        <s-stack direction="inline" alignItems="center" gap="small-200">
          <BatchStatusBadge status={batch.status} />
          <s-text color="subdued">{startedText}</s-text>
        </s-stack>
        {connection === 'reconnecting' ? <ConnectionNotice /> : null}

        {batch.delay === null ? null : <DelayBanner delay={batch.delay} />}
        {connection === 'stopped' ? (
          <s-banner tone="warning" heading="Could not refresh progress">
            What you see may be out of date.
            <s-button slot="secondary-actions" onClick={() => void query.refetch()}>
              Try again
            </s-button>
          </s-banner>
        ) : null}

        {attachBanner === null ? null : <NoticeBanner notice={attachBanner} onDismiss={dismissAttachBanner} />}

        {batch.items.map((item) => (
          <ItemSection
            key={item.id}
            item={item}
            expected={expected}
            busy={working}
            zipProgress={zipProgressOf(downloads.archive, item.id)}
            attaching={attaching === item.id}
            onOpen={setTarget}
            onDownload={() => void saveArchive(item.id, productArchiveFiles(item), productArchiveName(item.title))}
            onAttach={() => attachMedia(item.id, [item.id])}
          />
        ))}

        <SummarySection
          batch={batch}
          downloadCount={archiveFiles.length}
          saving={working}
          archive={downloads.archive?.scope === BATCH_SCOPE ? downloads.archive : null}
          onDownloadAll={downloadAll}
        />
      </s-page>

      <CancelModal onConfirm={cancelBatch} />
      <AttachModal
        productCount={attachable.length}
        onConfirm={() => attachMedia(BATCH_SCOPE, attachable.map((item) => item.id))}
      />
      <MediaViewer
        item={viewerItem}
        mediaId={target?.mediaId ?? null}
        saving={downloads.saving}
        onSelect={selectOutput}
        onClose={closeViewer}
        onDownload={(file) => void downloads.saveOne(file)}
      />
    </>
  );
}
