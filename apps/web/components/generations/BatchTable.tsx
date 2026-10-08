import type { BatchSummary } from '@rs/shared';
import { BatchRow } from './BatchRow';
import { ScreenReaderText, SkeletonBar } from './Skeleton';

const SKELETON_ROWS = [0, 1, 2, 3] as const;
const SKELETON_WIDTHS = [160, 80, 72, 120, 110] as const;

function SkeletonRows() {
  return SKELETON_ROWS.map((row) => (
    <s-table-row key={row}>
      {SKELETON_WIDTHS.map((width, column) => (
        <s-table-cell key={column}>
          <SkeletonBar width={width} />
          {row === 0 && column === 0 ? <ScreenReaderText>Loading generations</ScreenReaderText> : null}
        </s-table-cell>
      ))}
    </s-table-row>
  ));
}

interface BatchTableProps {
  batches: readonly BatchSummary[];
  loading?: boolean;
}

export function BatchTable({ batches, loading = false }: BatchTableProps) {
  return (
    <s-table>
      <s-table-header-row>
        <s-table-header listSlot="primary">Generation</s-table-header>
        <s-table-header listSlot="secondary">Created</s-table-header>
        <s-table-header listSlot="inline">Status</s-table-header>
        <s-table-header listSlot="labeled">Progress</s-table-header>
        <s-table-header listSlot="labeled">Ready</s-table-header>
      </s-table-header-row>
      <s-table-body>
        {loading ? <SkeletonRows /> : batches.map((batch) => <BatchRow key={batch.id} batch={batch} />)}
      </s-table-body>
    </s-table>
  );
}
