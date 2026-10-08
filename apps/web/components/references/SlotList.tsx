'use client';

import { canRetry } from '@/lib/state/draft';
import type { DraftReference } from '@/lib/state/draftTypes';
import { ReferenceSlot } from './ReferenceSlot';
import styles from './references.module.css';

interface SlotListProps {
  label: string;
  references: readonly DraftReference[];
  onRetry: (clientId: string) => void;
  onRemove: (clientId: string) => void;
}

// The tiles of one target, followed by the reason of every failed one (a 56 px tile has no room for it).
export function SlotList({ label, references, onRetry, onRemove }: SlotListProps) {
  if (references.length === 0) return null;
  const failed = references.filter((reference) => reference.status === 'failed' && reference.error !== null);

  return (
    <s-stack gap="small-200">
      <ul className={styles.slots} aria-label={label}>
        {references.map((reference) => (
          <ReferenceSlot
            key={reference.clientId}
            reference={reference}
            retryable={canRetry(reference)}
            onRetry={onRetry}
            onRemove={onRemove}
          />
        ))}
      </ul>
      {failed.map((reference) => (
        <s-text key={reference.clientId} tone="critical">
          {reference.filename}: {reference.error}
        </s-text>
      ))}
    </s-stack>
  );
}
