import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';
import { errorMessage, unresolvedProductGids } from '@/lib/api/errors';
import { useCreateBatch } from '@/lib/api/hooks';
import { buildBatchRequest } from '@/lib/references';
import { showToast } from '@/lib/shopify';
import { useDraftStore } from '@/lib/state';

// POST /batches for the draft. A 422 references_required names the products the server could not resolve;
// that list is kept until the references change. On success the draft is emptied and the batch opens.
export function useGenerate() {
  const router = useRouter();
  const createBatch = useCreateBatch();
  const [serverGids, setServerGids] = useState<readonly string[]>([]);
  const [leaving, setLeaving] = useState(false);
  const commonRefs = useDraftStore((state) => state.commonRefs);
  const productRefs = useDraftStore((state) => state.productRefs);

  useEffect(() => {
    setServerGids((current) => (current.length === 0 ? current : []));
  }, [commonRefs, productRefs]);

  const generate = useCallback(async (): Promise<void> => {
    try {
      const batch = await createBatch.mutateAsync(buildBatchRequest(useDraftStore.getState()));
      showToast('Generation queued');
      setLeaving(true);
      useDraftStore.getState().reset();
      router.push(`/generations/${batch.id}`);
    } catch (error) {
      const gids = unresolvedProductGids(error);
      if (gids !== null) setServerGids(gids);
      showToast(errorMessage(error, 'Could not queue the generation. Try again.'), true);
    }
  }, [createBatch, router]);

  return { generate, serverGids, submitting: createBatch.isPending || leaving, leaving };
}
