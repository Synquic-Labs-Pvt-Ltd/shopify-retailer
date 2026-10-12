import type { MediaType, StyleMode } from '@rs/shared';

// The generation draft (SPEC 16.2 References): selection, references per product, common references and the
// idempotency key. Persisted to localStorage so a reload resumes it.

export interface DraftProduct {
  id: string;
  title: string;
  imageUrl: string | null;
}

export type DraftReferenceStatus = 'uploading' | 'processing' | 'ready' | 'failed';

export interface DraftReference {
  clientId: string;
  mediaId: string | null;
  mediaType: MediaType;
  filename: string;
  mimeType: string;
  // Bytes of the file that is uploaded (after downscaling).
  fileSize: number;
  // Videos only.
  durationSec: number | null;
  status: DraftReferenceStatus;
  // 0 to 1 while uploading.
  progress: number;
  // A small local thumbnail (data URL) until the server preview replaces it.
  previewUrl: string | null;
  error: string | null;
}

// Where a reference goes: every product (common) or one product.
export type ReferenceTarget = { kind: 'common' } | { kind: 'product'; productId: string };

export interface DraftData {
  idempotencyKey: string;
  // The shop this draft belongs to; a draft never carries over to another shop.
  shopId: string | null;
  products: DraftProduct[];
  commonRefs: DraftReference[];
  productRefs: Record<string, DraftReference[]>;
  // The batch-level aesthetic: where every product's look comes from unless it sets its own (SPEC 9).
  // Defaults to 'apparel' so a generation needs no uploads out of the box.
  styleMode: StyleMode;
  // Per-product overrides of styleMode, keyed by product id. A product not in here follows styleMode.
  productStyleModes: Record<string, StyleMode>;
}

export type ToggleResult = 'added' | 'removed' | 'limit';

export type ReferencePatch = Partial<Omit<DraftReference, 'clientId'>>;

export interface DraftActions {
  // Claims an unbound draft for the shop; a draft that belongs to a different shop starts over.
  bindShop: (shopId: string) => void;
  // Adds or removes one product. 'limit' means the selection already holds maxProducts.
  toggleProduct: (product: DraftProduct, maxProducts: number) => ToggleResult;
  // Replaces the selection (duplicates dropped, cut to maxProducts). Resolves with the number cut.
  setProducts: (products: readonly DraftProduct[], maxProducts: number) => number;
  // Empties the selection. References already added stay: selecting the product again brings them back.
  // Per-product aesthetic overrides are dropped, since no product is selected.
  clearSelection: () => void;
  // Sets the batch-level aesthetic.
  setStyleMode: (mode: StyleMode) => void;
  // Overrides one product's aesthetic, or clears the override (back to the batch default) with null.
  setProductStyleMode: (productId: string, mode: StyleMode | null) => void;
  addRef: (target: ReferenceTarget, ref: DraftReference) => void;
  updateRef: (clientId: string, patch: ReferencePatch) => void;
  removeRef: (clientId: string) => void;
  setRefs: (target: ReferenceTarget, refs: readonly DraftReference[]) => void;
  // Clears everything but the shop binding and issues a new idempotency key (after a batch is created).
  reset: () => void;
}

export type DraftState = DraftData & DraftActions;
