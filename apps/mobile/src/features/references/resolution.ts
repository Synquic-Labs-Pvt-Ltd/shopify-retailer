import { resolveReferences, type CreateBatchInput, type ReferenceResolution } from '@rs/shared';
import type { DraftProduct, DraftReference } from '../../state/draft';

// SPEC 9, evaluated live: which references each selected product ends up with.
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

export function resolveProducts(
  products: readonly DraftProduct[],
  productRefs: Readonly<Record<string, DraftReference[]>>,
  commonRefs: readonly DraftReference[],
): ProductResolution[] {
  return products.map((product) => {
    const own = productRefs[product.id] ?? [];
    const { mode } = resolveReferences(own, commonRefs);
    return { product, own, mode, label: resolutionLabel(mode, own.length), unresolved: mode === 'none' };
  });
}

export function unresolvedMessage(count: number): string {
  const subject = count === 1 ? '1 product needs' : `${count} products need`;
  return `${subject} a reference. Add references to each product or add a common reference.`;
}

// Every slot that takes part in the batch has finished uploading and processing.
export function allSlotsReady(
  products: readonly DraftProduct[],
  productRefs: Readonly<Record<string, DraftReference[]>>,
  commonRefs: readonly DraftReference[],
): boolean {
  const own = products.flatMap((product) => productRefs[product.id] ?? []);
  return [...commonRefs, ...own].every((ref) => ref.status === 'ready');
}

function mediaIds(refs: readonly DraftReference[]): string[] {
  return refs.flatMap((ref) => (ref.mediaId === null ? [] : [ref.mediaId]));
}

// POST /batches body for the draft. Call it only when every slot is ready.
export function buildBatchRequest(
  idempotencyKey: string,
  products: readonly DraftProduct[],
  productRefs: Readonly<Record<string, DraftReference[]>>,
  commonRefs: readonly DraftReference[],
): CreateBatchInput {
  return {
    idempotencyKey,
    products: products.map((product) => ({
      productGid: product.id,
      referenceMediaIds: mediaIds(productRefs[product.id] ?? []),
    })),
    commonReferenceMediaIds: mediaIds(commonRefs),
  };
}
