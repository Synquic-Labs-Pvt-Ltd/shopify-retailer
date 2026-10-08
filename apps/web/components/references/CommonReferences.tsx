'use client';

import type { DraftReference } from '@/lib/state/draftTypes';
import { AddFilesButton } from './AddFilesButton';
import { FileDropZone } from './FileDropZone';
import { referenceCountLabel } from './logic';
import { SlotList } from './SlotList';

interface CommonReferencesProps {
  references: readonly DraftReference[];
  // The most style references a batch takes; unknown until /me has loaded.
  max: number | undefined;
  onFiles: (files: File[]) => void;
  onRetry: (clientId: string) => void;
  onRemove: (clientId: string) => void;
}

export function CommonReferences({ references, max, onFiles, onRetry, onRemove }: CommonReferencesProps) {
  return (
    <s-section
      heading="Style references"
      subheading="Used only for setting, lighting, mood and aesthetics. Clothing and products in these images are not copied."
    >
      <AddFilesButton slot="secondary-actions" label="Add style references" onFiles={onFiles} />
      <s-stack gap="base">
        <FileDropZone onFiles={onFiles} />
        <SlotList label="Style references" references={references} onRetry={onRetry} onRemove={onRemove} />
        {max !== undefined ? <s-text color="subdued">{referenceCountLabel(references.length, max)}</s-text> : null}
      </s-stack>
    </s-section>
  );
}
