import type { BatchStatus, ItemStatus } from '@rs/shared';
import { batchLabel, batchTone, itemLabel, itemTone } from '@/lib/batch/status';

export function BatchStatusBadge({ status }: { status: BatchStatus }) {
  return <s-badge tone={batchTone(status)}>{batchLabel(status)}</s-badge>;
}

export function ItemStatusBadge({ status }: { status: ItemStatus }) {
  return <s-badge tone={itemTone(status)}>{itemLabel(status)}</s-badge>;
}
