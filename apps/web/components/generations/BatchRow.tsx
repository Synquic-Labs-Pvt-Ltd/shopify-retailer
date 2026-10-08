import type { BatchSummary } from '@rs/shared';
import { plural, relativeTime } from '@/lib/batch/format';
import { batchLabel, batchProgress, batchTone } from '@/lib/batch/status';
import { percentText, readyText } from './logic';
import { BatchStatusBadge } from './StatusBadge';

function ProgressCell({ batch }: { batch: BatchSummary }) {
  const progress = batchProgress(batch.counts);
  return (
    <s-stack direction="inline" alignItems="center" gap="small-200">
      <s-box inlineSize="96px">
        <s-progress
          value={progress}
          tone={batchTone(batch.status)}
          accessibilityLabel={`${percentText(progress)} of the jobs finished`}
        />
      </s-box>
      <s-text color="subdued">{percentText(progress)}</s-text>
    </s-stack>
  );
}

// One generation. The whole row opens the detail page through the link in its first cell.
export function BatchRow({ batch }: { batch: BatchSummary }) {
  const linkId = `generation-link-${batch.id}`;
  const title = plural(batch.counts.products, 'product');
  const created = relativeTime(batch.createdAt);
  return (
    <s-table-row clickDelegate={linkId}>
      <s-table-cell>
        <s-stack direction="inline" alignItems="center" gap="base">
          <s-thumbnail size="small-200" src={batch.coverImageUrl ?? undefined} alt="" />
          <s-link
            id={linkId}
            href={`/generations/${batch.id}`}
            accessibilityLabel={`Open the generation of ${title}, ${batchLabel(batch.status)}, ${created}`}
          >
            {title}
          </s-link>
        </s-stack>
      </s-table-cell>
      <s-table-cell>{created}</s-table-cell>
      <s-table-cell>
        <BatchStatusBadge status={batch.status} />
      </s-table-cell>
      <s-table-cell>
        <ProgressCell batch={batch} />
      </s-table-cell>
      <s-table-cell>{readyText(batch.counts)}</s-table-cell>
    </s-table-row>
  );
}
