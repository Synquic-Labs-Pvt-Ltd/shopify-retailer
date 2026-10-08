import type { MediaObject } from '@rs/shared';
import type { DraftData, DraftReference } from '@/lib/state/draftTypes';
import { allDraftRefs } from '@/lib/state/draftData';
import { applyMediaStatus, type DraftAccess } from './uploadService';

// After POST /media/:id/complete a slot is 'processing'. The page polls GET /media?ids= (useMediaStatus) for
// those ids and passes each answer to a tracker, which settles the slots as 'ready' or 'failed'. Because the
// draft keeps the media ids, polling also resumes after a reload.
export const PROCESSING_TIMEOUT_MS = 5 * 60_000;
export const PROCESSING_TIMEOUT_MESSAGE = 'Processing took too long.';

export type ProcessingRef = DraftReference & { mediaId: string };

export function processingRefs(draft: Pick<DraftData, 'commonRefs' | 'productRefs'>): ProcessingRef[] {
  return allDraftRefs(draft).filter(
    (ref): ref is ProcessingRef => ref.status === 'processing' && ref.mediaId !== null,
  );
}

export interface ProcessingTracker {
  // Applies one poll result. Resolves with how many slots failed because of it.
  apply(draft: DraftAccess, items: readonly MediaObject[], now?: number): number;
}

export function createProcessingTracker(timeoutMs: number = PROCESSING_TIMEOUT_MS): ProcessingTracker {
  // When each processing slot was first seen without a final answer.
  const since = new Map<string, number>();
  return {
    apply: (draft, items, now = Date.now()) => {
      const state = draft.getState();
      const byId = new Map(items.map((media) => [media.id, media]));
      let failures = 0;
      for (const ref of processingRefs(state)) {
        const media = byId.get(ref.mediaId);
        if (media !== undefined && media.status !== 'processing' && media.status !== 'awaiting_upload') {
          since.delete(ref.clientId);
          const next = applyMediaStatus(ref, media);
          state.updateRef(ref.clientId, next);
          if (next.status === 'failed') failures += 1;
          continue;
        }
        // Still processing, or unknown to the server: give up after the timeout.
        const first = since.get(ref.clientId) ?? now;
        since.set(ref.clientId, first);
        if (now - first > timeoutMs) {
          since.delete(ref.clientId);
          state.updateRef(ref.clientId, { status: 'failed', progress: 0, error: PROCESSING_TIMEOUT_MESSAGE });
          failures += 1;
        }
      }
      return failures;
    },
  };
}
