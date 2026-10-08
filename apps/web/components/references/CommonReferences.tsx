'use client';

import type { DraftReference } from '@/lib/state/draftTypes';
import { AddFilesButton } from './AddFilesButton';
import { FileDropZone } from './FileDropZone';
import { referenceCountLabel } from './logic';
import { SlotList } from './SlotList';

interface CommonReferencesProps {
  references: readonly DraftReference[];
  // The most common references a batch takes; unknown until /me has loaded.
  max: number | undefined;
  onFiles: (files: File[]) => void;
  onRetry: (clientId: string) => void;
  onRemove: (clientId: string) => void;
}

export function CommonReferences({ references, max, onFiles, onRetry, onRemove }: CommonReferencesProps) {
  return (
    <s-section
      heading="Common references"
      subheading="Used for every product without its own references, and added to products that have their own."
    >
      <AddFilesButton slot="secondary-actions" label="Add files" onFiles={onFiles} />
      <s-stack gap="base">
        <FileDropZone onFiles={onFiles} />
        <SlotList label="Common references" references={references} onRetry={onRetry} onRemove={onRemove} />
        {max !== undefined ? <s-text color="subdued">{referenceCountLabel(references.length, max)}</s-text> : null}
      </s-stack>
    </s-section>
  );
}
