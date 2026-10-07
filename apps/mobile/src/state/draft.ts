import AsyncStorage from '@react-native-async-storage/async-storage';
import { useEffect, useState } from 'react';
import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';
import type { MediaType } from '@rs/shared';

// The generation draft (SPEC 16.2 References): selection, refs per product, common refs and the
// idempotency key. Persisted to AsyncStorage so an app kill resumes it.

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
  localUri: string;
  filename: string;
  mimeType: string;
  // Bytes of the file that is uploaded (after HEIC conversion and downscaling).
  fileSize: number;
  // Videos only.
  durationSec: number | null;
  status: DraftReferenceStatus;
  // 0 to 1 while uploading.
  progress: number;
  previewUrl: string | null;
  error: string | null;
}

interface DraftData {
  idempotencyKey: string;
  // The shop this draft belongs to; a draft never carries over to another shop.
  shopId: string | null;
  products: DraftProduct[];
  commonRefs: DraftReference[];
  productRefs: Record<string, DraftReference[]>;
}

export interface DraftState extends DraftData {
  toggleProduct: (product: DraftProduct) => void;
  setProducts: (products: DraftProduct[]) => void;
  addCommonRef: (ref: DraftReference) => void;
  addProductRef: (productId: string, ref: DraftReference) => void;
  updateRef: (clientId: string, patch: Partial<DraftReference>) => void;
  removeRef: (clientId: string) => void;
  // Starts a fresh draft when it belongs to a different shop.
  bindShop: (shopId: string) => void;
  // Clears everything and issues a new idempotency key (after a batch is created).
  reset: () => void;
}

// RFC 4122 version 4 UUID. Not a secret, so Math.random is enough for an idempotency key.
export function newIdempotencyKey(): string {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (char) => {
    const random = Math.floor(Math.random() * 16);
    return (char === 'x' ? random : (random & 0x3) | 0x8).toString(16);
  });
}

function emptyDraft(): DraftData {
  return { idempotencyKey: newIdempotencyKey(), shopId: null, products: [], commonRefs: [], productRefs: {} };
}

function patchRefs(refs: DraftReference[], clientId: string, patch: Partial<DraftReference>): DraftReference[] {
  return refs.map((ref) => (ref.clientId === clientId ? { ...ref, ...patch } : ref));
}

const INTERRUPTED_MESSAGE = 'The upload was interrupted.';

// An upload cannot outlive the app process: whatever was mid-upload at the last save needs a retry.
function settleInterrupted(refs: DraftReference[]): DraftReference[] {
  return refs.map((ref) =>
    ref.status === 'uploading' ? { ...ref, status: 'failed', progress: 0, error: INTERRUPTED_MESSAGE } : ref,
  );
}

function restoreDraft(persisted: unknown, current: DraftState): DraftState {
  if (typeof persisted !== 'object' || persisted === null) return current;
  const saved = persisted as Partial<DraftData>;
  return {
    ...current,
    idempotencyKey: saved.idempotencyKey ?? current.idempotencyKey,
    shopId: saved.shopId ?? null,
    products: saved.products ?? [],
    commonRefs: settleInterrupted(saved.commonRefs ?? []),
    productRefs: Object.fromEntries(
      Object.entries(saved.productRefs ?? {}).map(([id, refs]) => [id, settleInterrupted(refs)]),
    ),
  };
}

export const useDraftStore = create<DraftState>()(
  persist(
    (set) => ({
      ...emptyDraft(),
      toggleProduct: (product) =>
        set((state) =>
          state.products.some((p) => p.id === product.id)
            ? { products: state.products.filter((p) => p.id !== product.id) }
            : { products: [...state.products, product] },
        ),
      setProducts: (products) => set({ products }),
      addCommonRef: (ref) => set((state) => ({ commonRefs: [...state.commonRefs, ref] })),
      addProductRef: (productId, ref) =>
        set((state) => ({
          productRefs: { ...state.productRefs, [productId]: [...(state.productRefs[productId] ?? []), ref] },
        })),
      updateRef: (clientId, patch) =>
        set((state) => ({
          commonRefs: patchRefs(state.commonRefs, clientId, patch),
          productRefs: Object.fromEntries(
            Object.entries(state.productRefs).map(([id, refs]) => [id, patchRefs(refs, clientId, patch)]),
          ),
        })),
      removeRef: (clientId) =>
        set((state) => ({
          commonRefs: state.commonRefs.filter((ref) => ref.clientId !== clientId),
          productRefs: Object.fromEntries(
            Object.entries(state.productRefs).map(([id, refs]) => [id, refs.filter((ref) => ref.clientId !== clientId)]),
          ),
        })),
      bindShop: (shopId) =>
        set((state) => (state.shopId === shopId ? state : { ...emptyDraft(), shopId })),
      reset: () => set((state) => ({ ...emptyDraft(), shopId: state.shopId })),
    }),
    {
      name: 'rs-draft',
      version: 2,
      storage: createJSONStorage(() => AsyncStorage),
      partialize: (state): DraftData => ({
        idempotencyKey: state.idempotencyKey,
        shopId: state.shopId,
        products: state.products,
        commonRefs: state.commonRefs,
        productRefs: state.productRefs,
      }),
      // Version 1 drafts predate the feature screens and carried no uploads worth keeping.
      migrate: () => emptyDraft(),
      merge: restoreDraft,
    },
  ),
);

// True once the persisted draft has been read from AsyncStorage.
export function useDraftHydrated(): boolean {
  const [hydrated, setHydrated] = useState(() => useDraftStore.persist.hasHydrated());
  useEffect(() => {
    setHydrated(useDraftStore.persist.hasHydrated());
    return useDraftStore.persist.onFinishHydration(() => setHydrated(true));
  }, []);
  return hydrated;
}

export function allDraftRefs(state: DraftData): DraftReference[] {
  return [...state.commonRefs, ...Object.values(state.productRefs).flat()];
}
