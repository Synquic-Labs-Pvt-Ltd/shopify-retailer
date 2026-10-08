'use client';

import { useCallback, useMemo, useState } from 'react';
import { errorMessage } from '@/lib/api/errors';
import { useBatch, useCancelBatch, useRetryFailed } from '@/lib/api/hooks';
import { plural, relativeTime } from '@/lib/batch/format';
import { showToast } from '@/lib/shopify';
import { CANCEL_MODAL_ID, CancelModal } from './CancelModal';
import { DelayBanner } from './DelayBanner';
import { ItemSection } from './ItemSection';
import {
  canCancelBatch,
  canRetryFailed,
  downloadItemsOfBatch,
  isBatchNotFound,
  isValidBatchId,
  outputsPerProduct,
  type ViewerTarget,
} from './logic';
import { MediaViewer } from './MediaViewer';
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
// ends. Outputs open in the media viewer; "Download all" saves every ready output.
export function BatchDetailView({ id }: { id: string }) {
  const validId = isValidBatchId(id);
  const query = useBatch(validId ? id : '');
  const cancel = useCancelBatch();
  const retry = useRetryFailed();
  const downloads = useDownloads();
  const [target, setTarget] = useState<ViewerTarget | null>(null);
  const batch = query.data;

  const { saveAll } = downloads;
  const downloadItems = useMemo(() => (batch === undefined ? [] : downloadItemsOfBatch(batch)), [batch]);
  const viewerItem = useMemo(
    () => (target === null ? undefined : batch?.items.find((candidate) => candidate.id === target.itemId)),
    [batch, target],
  );

  const closeViewer = useCallback(() => setTarget(null), []);
  const selectOutput = useCallback(
    (mediaId: string) => setTarget((current) => (current === null ? null : { ...current, mediaId })),
    [],
  );
  const downloadAll = useCallback(() => void saveAll(downloadItems), [saveAll, downloadItems]);

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

  const expected = outputsPerProduct(batch);
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

        <s-stack direction="inline" alignItems="center" gap="small-200">
          <BatchStatusBadge status={batch.status} />
          <s-text color="subdued">{startedText}</s-text>
        </s-stack>

        {batch.delay === null ? null : <DelayBanner delay={batch.delay} />}
        {query.isError ? (
          <s-banner tone="warning" heading="Could not refresh progress">
            What you see may be out of date.
            <s-button slot="secondary-actions" onClick={() => void query.refetch()}>
              Try again
            </s-button>
          </s-banner>
        ) : null}

        {batch.items.map((item) => (
          <ItemSection key={item.id} item={item} expected={expected} onOpen={setTarget} />
        ))}

        <SummarySection
          batch={batch}
          downloadCount={downloadItems.length}
          saving={downloads.saving}
          bulk={downloads.bulk}
          onDownloadAll={downloadAll}
        />
      </s-page>

      <CancelModal onConfirm={cancelBatch} />
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
