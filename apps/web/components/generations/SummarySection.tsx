import type { ReactNode } from 'react';
import type { BatchDetail } from '@rs/shared';
import { batchProgress, batchTone } from '@/lib/batch/status';
import {
  DOWNLOAD_ALL_LABEL,
  archiveProgressLabel,
  outputsReady,
  outputsTotal,
  percentText,
  type ArchiveProgress,
} from './logic';
import { BatchStatusBadge } from './StatusBadge';

function SummaryRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <s-stack direction="inline" alignItems="center" justifyContent="space-between" gap="base">
      <s-text color="subdued">{label}</s-text>
      {children}
    </s-stack>
  );
}

interface SummarySectionProps {
  batch: BatchDetail;
  // Number of outputs "Download all" would put in the zip.
  downloadCount: number;
  // Any save is running (single or zip): the button waits.
  saving: boolean;
  // Set while the zip of the whole batch is being built.
  archive: ArchiveProgress | null;
  onDownloadAll: () => void;
}

// The aside of the detail page: status, counts, progress and "Download all (.zip)".
export function SummarySection({ batch, downloadCount, saving, archive, onDownloadAll }: SummarySectionProps) {
  const progress = batchProgress(batch.counts);
  return (
    <s-section slot="aside" heading="Summary">
      <s-stack gap="base">
        <SummaryRow label="Status">
          <BatchStatusBadge status={batch.status} />
        </SummaryRow>
        <SummaryRow label="Products">
          <s-text type="strong">{batch.counts.products}</s-text>
        </SummaryRow>
        <SummaryRow label="Outputs ready">
          <s-text type="strong">{`${outputsReady(batch.counts)} of ${outputsTotal(batch)}`}</s-text>
        </SummaryRow>
        <s-progress
          value={progress}
          tone={batchTone(batch.status)}
          accessibilityLabel={`${percentText(progress)} of the jobs finished`}
        />
        <s-divider />
        <s-button
          inlineSize="fill"
          icon="download"
          loading={archive !== null}
          disabled={downloadCount === 0 || saving}
          onClick={onDownloadAll}
        >
          {archive === null ? DOWNLOAD_ALL_LABEL : archiveProgressLabel(archive.done, archive.total)}
        </s-button>
        {archive === null ? null : (
          <s-progress
            value={archive.total === 0 ? 0 : archive.done / archive.total}
            accessibilityLabel={archiveProgressLabel(archive.done, archive.total)}
          />
        )}
      </s-stack>
    </s-section>
  );
}
