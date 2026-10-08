'use client';

import { useRef } from 'react';
import { useElementEvent } from '@/components/polaris/useElementEvent';
import type { AttachNotice } from './attach';

interface NoticeBannerProps {
  notice: AttachNotice;
  onDismiss: () => void;
}

// A banner the merchant can close. The close button fires the lowercase Polaris event `dismiss`, which React 19 does
// not route to props.
export function NoticeBanner({ notice, onDismiss }: NoticeBannerProps) {
  const ref = useRef<HTMLElementTagNameMap['s-banner']>(null);
  useElementEvent(ref, 'dismiss', onDismiss);
  return (
    <s-banner ref={ref} tone="warning" heading={notice.heading} dismissible>
      <s-stack gap="small-200">
        <s-text>{notice.message}</s-text>
        <s-text color="subdued">{notice.hint}</s-text>
      </s-stack>
    </s-banner>
  );
}
