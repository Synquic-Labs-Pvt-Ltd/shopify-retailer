import { useEffect, useMemo, useRef } from 'react';
import { useMediaStatus } from '../../api/media';
import { useDraftStore, type DraftReference } from '../../state/draft';
import { applyMediaStatus, failReference } from './uploadService';

const PROCESSING_TIMEOUT_MS = 5 * 60_000;

// Polls GET /media?ids= for every reference the store is still processing, and writes the answer back to the
// draft. It also resumes after an app kill, because the draft keeps the media ids.
// onFailed receives how many references failed during one poll.
export function useReferenceProcessing(onFailed: (count: number) => void): void {
  const commonRefs = useDraftStore((state) => state.commonRefs);
  const productRefs = useDraftStore((state) => state.productRefs);
  const since = useRef(new Map<string, number>());
  const notify = useRef(onFailed);
  notify.current = onFailed;

  const processing = useMemo(
    () =>
      [...commonRefs, ...Object.values(productRefs).flat()].filter(
        (ref): ref is DraftReference & { mediaId: string } => ref.status === 'processing' && ref.mediaId !== null,
      ),
    [commonRefs, productRefs],
  );
  const status = useMediaStatus(processing.map((ref) => ref.mediaId));
  const { data, dataUpdatedAt } = status;

  useEffect(() => {
    if (data === undefined) return;
    const now = Date.now();
    const byId = new Map(data.items.map((media) => [media.id, media]));
    let failures = 0;
    for (const ref of processing) {
      const media = byId.get(ref.mediaId);
      if (media !== undefined && media.status !== 'processing' && media.status !== 'awaiting_upload') {
        since.current.delete(ref.clientId);
        applyMediaStatus(ref.clientId, media);
        if (media.status === 'failed' || media.status === 'deleted') failures += 1;
        continue;
      }
      // Still processing, or unknown to the server: give up after five minutes.
      const first = since.current.get(ref.clientId) ?? now;
      since.current.set(ref.clientId, first);
      if (now - first > PROCESSING_TIMEOUT_MS) {
        since.current.delete(ref.clientId);
        failReference(ref.clientId, 'Processing took too long.');
        failures += 1;
      }
    }
    if (failures > 0) notify.current(failures);
    // Only a new poll result may re-run this: applying it changes `processing` again.
  }, [dataUpdatedAt]);
}
