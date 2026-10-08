'use client';

import { useRef } from 'react';
import { useElementEvent } from '@/components/polaris/useElementEvent';
import { BLOCKED_UPLOAD_MESSAGE } from './logic';

// Shown when the browser refused to send a file to Shopify's storage (typically a CORS block). Retrying the
// slot is the next step, so the banner can be dismissed.
export function BlockedUploadBanner({ onDismiss }: { onDismiss: () => void }) {
  const ref = useRef<HTMLElementTagNameMap['s-banner']>(null);
  useElementEvent(ref, 'dismiss', onDismiss);

  return (
    <s-banner ref={ref} tone="critical" heading="Upload blocked" dismissible>
      {BLOCKED_UPLOAD_MESSAGE}
    </s-banner>
  );
}
