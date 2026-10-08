import { resolveReferences, type CreateBatchInput, type ReferenceResolution } from '@rs/shared';
import type { DraftData, DraftProduct, DraftReference } from '@/lib/state/draftTypes';

// SPEC 9, evaluated live: which references each selected product ends up with.
type ResolutionDraft = Pick<DraftData, 'products' | 'commonRefs' | 'productRefs'>;

export interface ProductResolution {
  product: DraftProduct;
  own: DraftReference[];
  mode: ReferenceResolution;
  label: string;
  unresolved: boolean;
}

export function resolutionLabel(mode: ReferenceResolution, ownCount: number): string {
  const own = `${ownCount} ${ownCount === 1 ? 'reference' : 'references'}`;
  switch (mode) {
    case 'own_plus_common':
      return `${own} + common`;
    case 'own_only':
      return own;
    case 'common_only':
      return 'Uses common references';
    case 'none':
      return 'Needs a reference';
  }
}

export function resolveProducts(draft: ResolutionDraft): ProductResolution[] {
  return draft.products.map((product) => {
    const own = draft.productRefs[product.id] ?? [];
    const { mode } = resolveReferences(own, draft.commonRefs);
    return { product, own, mode, label: resolutionLabel(mode, own.length), unresolved: mode === 'none' };
  });
}

export function unresolvedProductIds(draft: ResolutionDraft): string[] {
  return resolveProducts(draft)
    .filter((resolution) => resolution.unresolved)
    .map((resolution) => resolution.product.id);
}

export function unresolvedMessage(count: number): string {
  const subject = count === 1 ? '1 product needs' : `${count} products need`;
  return `${subject} a reference. Add references to each product or add a common reference.`;
}

// The ids to show as unresolved: the ones this device computed plus the ones a 422 references_required named.
// A change to the draft supersedes the server's list, so the page clears it then (see unresolvedProductGids).
export function mergeUnresolved(serverGids: readonly string[], local: readonly string[]): ReadonlySet<string> {
  return new Set([...local, ...serverGids]);
}

// Every slot that takes part in the batch (the common ones and those of the selected products) is ready.
export function allSlotsReady(draft: ResolutionDraft): boolean {
  const own = draft.products.flatMap((product) => draft.productRefs[product.id] ?? []);
  return [...draft.commonRefs, ...own].every((ref) => ref.status === 'ready');
}

function readyMediaIds(refs: readonly DraftReference[]): string[] {
  return refs.flatMap((ref) => (ref.status === 'ready' && ref.mediaId !== null ? [ref.mediaId] : []));
}

// POST /batches body for the draft. Only ready slots are sent; call it when allSlotsReady is true.
export function buildBatchRequest(draft: ResolutionDraft & Pick<DraftData, 'idempotencyKey'>): CreateBatchInput {
  return {
    idempotencyKey: draft.idempotencyKey,
    products: draft.products.map((product) => ({
      productGid: product.id,
      referenceMediaIds: readyMediaIds(draft.productRefs[product.id] ?? []),
    })),
    commonReferenceMediaIds: readyMediaIds(draft.commonRefs),
  };
}
