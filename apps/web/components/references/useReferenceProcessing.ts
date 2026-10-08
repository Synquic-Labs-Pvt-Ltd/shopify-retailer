import { useEffect, useMemo, useRef, useState } from 'react';
import { useMediaStatus } from '@/lib/api/hooks';
import { createProcessingTracker, processingRefs } from '@/lib/references';
import { useDraftStore } from '@/lib/state';

// GET /media accepts at most 50 ids. More slots than that are never processing at once; the rest are polled as
// soon as these settle.
const MAX_POLLED = 50;

// Polls the media status of every slot that is still processing and writes the answer to the draft. Because the
// draft keeps the media ids, polling also resumes after a reload. `onFailed` gets the number of slots that
// failed during one poll.
export function useReferenceProcessing(onFailed: (count: number) => void): void {
  const commonRefs = useDraftStore((state) => state.commonRefs);
  const productRefs = useDraftStore((state) => state.productRefs);
  const [tracker] = useState(() => createProcessingTracker());
  const notify = useRef(onFailed);
  notify.current = onFailed;

  const ids = useMemo(
    () =>
      processingRefs({ commonRefs, productRefs })
        .map((ref) => ref.mediaId)
        .slice(0, MAX_POLLED),
    [commonRefs, productRefs],
  );
  const { data, dataUpdatedAt } = useMediaStatus(ids);

  useEffect(() => {
    if (data === undefined) return;
    const failures = tracker.apply(useDraftStore, data.items);
    if (failures > 0) notify.current(failures);
    // Only a new poll result may re-run this: applying it changes the ids again.
  }, [dataUpdatedAt]);
}
