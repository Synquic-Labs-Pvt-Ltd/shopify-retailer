'use client';

import { useLayoutEffect, useRef } from 'react';
import { useElementEvent } from '@/components/polaris/useElementEvent';
import type { DownloadQuality } from '@/lib/download-quality';
import { DOWNLOAD_QUALITY_DETAILS, DOWNLOAD_QUALITY_LABEL } from './logic';

interface DownloadQualityToggleProps {
  quality: DownloadQuality;
  onChange: (quality: DownloadQuality) => void;
}

// "Original quality": on saves the stored file untouched, off a smaller web JPEG. Controlled by its props the same way
// as SelectCheckbox: the element flips itself when clicked, then is put back to what the props say.
export function DownloadQualityToggle({ quality, onChange }: DownloadQualityToggleProps) {
  const ref = useRef<HTMLElementTagNameMap['s-checkbox']>(null);
  const original = quality === 'original';
  const shown = useRef(original);
  useLayoutEffect(() => {
    shown.current = original;
  });

  useElementEvent(ref, 'change', (element) => {
    onChange(element.checked ? 'original' : 'standard');
    queueMicrotask(() => {
      element.checked = shown.current;
    });
  });

  return <s-checkbox ref={ref} checked={original} label={DOWNLOAD_QUALITY_LABEL} details={DOWNLOAD_QUALITY_DETAILS} />;
}
