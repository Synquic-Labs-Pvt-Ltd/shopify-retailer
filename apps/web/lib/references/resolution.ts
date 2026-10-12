import { resolveReferences, type CreateBatchInput, type ReferenceResolution, type StyleMode } from '@rs/shared';
import type { DraftData, DraftProduct, DraftReference } from '@/lib/state/draftTypes';

// SPEC 9, evaluated live: the aesthetic and which references each selected product ends up with.
type ResolutionDraft = Pick<DraftData, 'products' | 'commonRefs' | 'productRefs'>;
type StyleDraft = ResolutionDraft & Pick<DraftData, 'styleMode' | 'productStyleModes'>;

export interface ProductResolution {
  product: DraftProduct;
  own: DraftReference[];
  // How the product's references resolve (SPEC 9), independent of the aesthetic.
  mode: ReferenceResolution;
  // The effective aesthetic: the per-product override, or the batch default.
  styleMode: StyleMode;
  // The per-product override, or null when the product follows the batch default.
  override: StyleMode | null;
  label: string;
  // Only 'reference' products with no reference anywhere block the batch; apparel/studio need no upload.
  unresolved: boolean;
}

// The short, generic name of an aesthetic, for chips and the per-product "Using:" hint.
export const STYLE_MODE_LABELS: Record<StyleMode, string> = {
  apparel: 'From the apparel',
  studio: 'Studio',
  reference: 'Custom references',
};

// The aesthetics in the order the chip groups offer them.
export const STYLE_MODE_OPTIONS: readonly StyleMode[] = ['apparel', 'studio', 'reference'];

export function resolutionLabel(mode: ReferenceResolution, ownCount: number): string {
  const own = `${ownCount} ${ownCount === 1 ? 'photo' : 'photos'}`;
  switch (mode) {
    case 'own_plus_common':
      return `${own} + style`;
    case 'own_only':
      return own;
    case 'common_only':
      return 'Style references only';
    case 'none':
      return 'Needs a reference';
  }
}

// The product badge: apparel/studio read as their aesthetic; a reference product reads as its resolution
// (its references, or "Needs a reference" when it has none).
export function styleModeLabel(styleMode: StyleMode, referenceMode: ReferenceResolution, ownCount: number): string {
  return styleMode === 'reference' ? resolutionLabel(referenceMode, ownCount) : STYLE_MODE_LABELS[styleMode];
}

export function resolveProducts(draft: StyleDraft): ProductResolution[] {
  return draft.products.map((product) => {
    const own = draft.productRefs[product.id] ?? [];
    const override = draft.productStyleModes[product.id] ?? null;
    const styleMode = override ?? draft.styleMode;
    const { mode } = resolveReferences(own, draft.commonRefs);
    const unresolved = styleMode === 'reference' && mode === 'none';
    return { product, own, mode, styleMode, override, label: styleModeLabel(styleMode, mode, own.length), unresolved };
  });
}

export function unresolvedProductIds(draft: StyleDraft): string[] {
  return resolveProducts(draft)
    .filter((resolution) => resolution.unresolved)
    .map((resolution) => resolution.product.id);
}

export function unresolvedMessage(count: number): string {
  const subject = count === 1 ? '1 product needs' : `${count} products need`;
  return `${subject} a reference. Add photos to each product or add a style reference.`;
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

// POST /batches body for the draft. Only ready slots are sent; call it when allSlotsReady is true. The
// batch-level styleMode goes on the body; a product carries its own styleMode only when it overrides the default.
export function buildBatchRequest(draft: StyleDraft & Pick<DraftData, 'idempotencyKey'>): CreateBatchInput {
  return {
    idempotencyKey: draft.idempotencyKey,
    styleMode: draft.styleMode,
    products: draft.products.map((product) => {
      const override = draft.productStyleModes[product.id];
      return {
        productGid: product.id,
        referenceMediaIds: readyMediaIds(draft.productRefs[product.id] ?? []),
        ...(override !== undefined && override !== draft.styleMode ? { styleMode: override } : {}),
      };
    }),
    commonReferenceMediaIds: readyMediaIds(draft.commonRefs),
  };
}
