'use client';

import { useLayoutEffect, useRef } from 'react';
import { useElementEvent } from '@/components/polaris/useElementEvent';
import type { DownloadQuality } from '@/lib/download-quality';
import { DOWNLOAD_QUALITY_DETAILS, DOWNLOAD_QUALITY_LABEL } from './logic';

const TOOLTIP_ID = 'download-quality-tooltip';

interface DownloadQualityToggleProps {
  quality: DownloadQuality;
  onChange: (quality: DownloadQuality) => void;
}

// "Original quality" on one line: on saves the stored file untouched, off a smaller web JPEG. The longer explanation is
// a tooltip on the label (a checkbox cannot carry one itself), and it is also the checkbox's accessible name so it is
// not lost to people who cannot hover. The label toggles the checkbox when clicked, as a label would.
//
// The checkbox is controlled by its props the same way as SelectCheckbox: the element flips itself when clicked, then
// is put back to what the props say.
export function DownloadQualityToggle({ quality, onChange }: DownloadQualityToggleProps) {
  const ref = useRef<HTMLElementTagNameMap['s-checkbox']>(null);
  const labelRef = useRef<HTMLElementTagNameMap['s-text']>(null);
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

  // Polaris elements have no typed onClick: listen natively, like the checkbox above.
  useElementEvent(labelRef, 'click', () => onChange(original ? 'standard' : 'original'));

  return (
    <s-stack direction="inline" alignItems="center" gap="small-200">
      <s-checkbox ref={ref} checked={original} accessibilityLabel={`${DOWNLOAD_QUALITY_LABEL}. ${DOWNLOAD_QUALITY_DETAILS}`} />
      <s-text ref={labelRef} interestFor={TOOLTIP_ID}>
        {DOWNLOAD_QUALITY_LABEL}
      </s-text>
      <s-tooltip id={TOOLTIP_ID}>{DOWNLOAD_QUALITY_DETAILS}</s-tooltip>
    </s-stack>
  );
}
