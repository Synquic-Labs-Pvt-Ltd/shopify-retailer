'use client';

import { useRef } from 'react';
import { useElementEvent } from '@/components/polaris/useElementEvent';
import { showToast } from '@/lib/shopify';
import { FILE_ACCEPT, takeNewFiles } from './logic';

type DropZone = HTMLElementTagNameMap['s-drop-zone'];

// Images and videos can be dropped here (or picked by clicking). The drop zone keeps the files it was given,
// so they are copied out and the zone is reset after every event.
export function FileDropZone({ onFiles }: { onFiles: (files: File[]) => void }) {
  const ref = useRef<DropZone>(null);
  const seen = useRef(new WeakSet<File>());

  const take = (element: DropZone): void => {
    const fresh = takeNewFiles([...element.files], seen.current);
    element.value = '';
    if (fresh.length > 0) onFiles(fresh);
  };
  useElementEvent(ref, 'change', take);
  useElementEvent(ref, 'input', take);
  useElementEvent(ref, 'droprejected', () => showToast('Only images and videos can be added.', true));

  return (
    <s-drop-zone
      ref={ref}
      accept={FILE_ACCEPT}
      multiple
      label="Reference files"
      labelAccessibilityVisibility="exclusive"
    >
      <s-box padding="large-100">
        <s-stack alignItems="center" gap="small-200">
          <s-icon type="image-add" />
          <s-text color="subdued">Drop images and videos here, or click to browse</s-text>
        </s-stack>
      </s-box>
    </s-drop-zone>
  );
}
