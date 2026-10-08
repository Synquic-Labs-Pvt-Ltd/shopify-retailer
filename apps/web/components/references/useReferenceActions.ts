import { useCallback, useState } from 'react';
import { useMe } from '@/lib/api/hooks';
import { addReferenceFiles, uploadService, type ReferenceTarget } from '@/lib/references';
import { showToast } from '@/lib/shopify';
import { addResultMessage, RETRY_FAILED_MESSAGE, SETTINGS_LOADING_MESSAGE } from './logic';

// The reference actions of the page. The upload pipeline lives outside React; this adds the limits from /me,
// the single toast for the outcome of an add, and the blocked-upload flag behind the banner.
export function useReferenceActions() {
  const me = useMe();
  const limits = me.data?.generation.references;
  const refetchMe = me.refetch;
  const [blocked, setBlocked] = useState(false);

  const add = useCallback(
    async (target: ReferenceTarget, files: readonly File[]): Promise<void> => {
      if (files.length === 0) return;
      if (limits === undefined) {
        showToast(SETTINGS_LOADING_MESSAGE, true);
        void refetchMe();
        return;
      }
      try {
        const result = await addReferenceFiles(target, files, limits);
        if (result.uploads.blocked) setBlocked(true);
        const message = addResultMessage(result);
        if (message !== null) showToast(message, true);
      } catch {
        showToast('The files could not be added. Try again.', true);
      }
    },
    [limits, refetchMe],
  );

  const retry = useCallback(async (clientId: string): Promise<void> => {
    const summary = await uploadService.retry(clientId);
    if (summary.blocked) setBlocked(true);
    else if (summary.failed > 0) showToast(RETRY_FAILED_MESSAGE, true);
    else setBlocked(false);
  }, []);

  const remove = useCallback((clientId: string): void => uploadService.remove(clientId), []);
  const dismissBlocked = useCallback((): void => setBlocked(false), []);

  return { limits, blocked, add, retry, remove, dismissBlocked };
}
