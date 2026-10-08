import type { ReactNode } from 'react';
import type { BatchDetail } from '@rs/shared';
import { batchProgress, batchTone } from '@/lib/batch/status';
import { downloadAllLabel, outputsReady, outputsTotal, percentText, savingLabel } from './logic';
import { BatchStatusBadge } from './StatusBadge';
import type { BulkProgress } from './useDownloads';

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
  // Number of outputs "Download all" would save.
  downloadCount: number;
  // Any save is running (single or bulk): the button waits.
  saving: boolean;
  // Set while "Download all" runs.
  bulk: BulkProgress | null;
  onDownloadAll: () => void;
}

// The aside of the detail page: status, counts, progress and "Download all".
export function SummarySection({ batch, downloadCount, saving, bulk, onDownloadAll }: SummarySectionProps) {
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
        <s-button inlineSize="fill" icon="download" disabled={downloadCount === 0 || saving} onClick={onDownloadAll}>
          {bulk === null ? downloadAllLabel(downloadCount) : savingLabel(bulk.done, bulk.total)}
        </s-button>
      </s-stack>
    </s-section>
  );
}
