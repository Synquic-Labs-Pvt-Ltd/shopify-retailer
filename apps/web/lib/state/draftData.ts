import { MEDIA_TYPES } from '@rs/shared';
import { z } from 'zod';
import type { DraftData, DraftReference, DraftState, ReferenceTarget } from './draftTypes';
import { newId } from './ids';

type RefLists = Pick<DraftData, 'commonRefs' | 'productRefs'>;

export const INTERRUPTED_MESSAGE = 'The upload was interrupted.';

export function emptyDraft(): DraftData {
  return { idempotencyKey: newId(), shopId: null, products: [], commonRefs: [], productRefs: {} };
}

export function refsOf(state: RefLists, target: ReferenceTarget): DraftReference[] {
  return target.kind === 'common' ? state.commonRefs : (state.productRefs[target.productId] ?? []);
}

// Every reference in the draft, including those of products that are no longer selected.
export function allDraftRefs(state: RefLists): DraftReference[] {
  return [...state.commonRefs, ...Object.values(state.productRefs).flat()];
}

export function findRef(state: RefLists, clientId: string): { ref: DraftReference; target: ReferenceTarget } | null {
  const common = state.commonRefs.find((ref) => ref.clientId === clientId);
  if (common !== undefined) return { ref: common, target: { kind: 'common' } };
  for (const [productId, refs] of Object.entries(state.productRefs)) {
    const ref = refs.find((candidate) => candidate.clientId === clientId);
    if (ref !== undefined) return { ref, target: { kind: 'product', productId } };
  }
  return null;
}

// The state slice that replaces the references of one target. An emptied product list is dropped.
export function withRefs(state: RefLists, target: ReferenceTarget, refs: readonly DraftReference[]): RefLists {
  if (target.kind === 'common') return { commonRefs: [...refs], productRefs: state.productRefs };
  const others = Object.fromEntries(Object.entries(state.productRefs).filter(([id]) => id !== target.productId));
  return {
    commonRefs: state.commonRefs,
    productRefs: refs.length > 0 ? { ...others, [target.productId]: [...refs] } : others,
  };
}

const referenceSchema = z.object({
  clientId: z.string().min(1),
  mediaId: z.string().nullable(),
  mediaType: z.enum(MEDIA_TYPES),
  filename: z.string(),
  mimeType: z.string(),
  fileSize: z.number().nonnegative(),
  durationSec: z.number().nonnegative().nullable(),
  status: z.enum(['uploading', 'processing', 'ready', 'failed']),
  progress: z.number(),
  previewUrl: z.string().nullable(),
  error: z.string().nullable(),
});

const persistedSchema = z.object({
  idempotencyKey: z.string().min(1),
  shopId: z.string().nullable(),
  products: z.array(z.object({ id: z.string().min(1), title: z.string(), imageUrl: z.string().nullable() })),
  commonRefs: z.array(referenceSchema),
  productRefs: z.record(z.string(), z.array(referenceSchema)),
});

// An upload cannot outlive the page, and its File is gone: whatever was mid-upload at the last save is
// failed for good (remove only). A processing slot without a media id could never be polled.
function settleInterrupted(refs: readonly DraftReference[]): DraftReference[] {
  return refs.map((ref) =>
    ref.status === 'uploading' || (ref.status === 'processing' && ref.mediaId === null)
      ? { ...ref, status: 'failed', progress: 0, error: INTERRUPTED_MESSAGE }
      : ref,
  );
}

// Merges the persisted draft into the fresh state. Anything that does not parse starts an empty draft.
export function restoreDraft(persisted: unknown, current: DraftState): DraftState {
  const parsed = persistedSchema.safeParse(persisted);
  if (!parsed.success) return current;
  const saved = parsed.data;
  return {
    ...current,
    idempotencyKey: saved.idempotencyKey,
    shopId: saved.shopId,
    products: saved.products,
    commonRefs: settleInterrupted(saved.commonRefs),
    productRefs: Object.fromEntries(
      Object.entries(saved.productRefs).map(([productId, refs]) => [productId, settleInterrupted(refs)]),
    ),
  };
}

export function partializeDraft(state: DraftData): DraftData {
  return {
    idempotencyKey: state.idempotencyKey,
    shopId: state.shopId,
    products: state.products,
    commonRefs: state.commonRefs,
    productRefs: state.productRefs,
  };
}
