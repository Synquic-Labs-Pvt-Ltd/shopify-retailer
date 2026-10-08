import type { BatchDelay } from '@rs/shared';
import { delayBannerText } from '@/lib/batch/status';

// SPEC 11.2: shown while a lane of the batch is paused, for example "Provider busy, resumes around 3:45 PM."
export function DelayBanner({ delay }: { delay: BatchDelay }) {
  return (
    <s-banner tone="warning" heading="Generation is delayed">
      {delayBannerText(delay)}
    </s-banner>
  );
}
