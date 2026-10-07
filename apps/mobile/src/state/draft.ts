import AsyncStorage from '@react-native-async-storage/async-storage';
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
  status: DraftReferenceStatus;
  // 0 to 1 while uploading.
  progress: number;
  previewUrl: string | null;
  error: string | null;
}

interface DraftData {
  idempotencyKey: string;
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
  return { idempotencyKey: newIdempotencyKey(), products: [], commonRefs: [], productRefs: {} };
}

function patchRefs(refs: DraftReference[], clientId: string, patch: Partial<DraftReference>): DraftReference[] {
  return refs.map((ref) => (ref.clientId === clientId ? { ...ref, ...patch } : ref));
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
      reset: () => set(emptyDraft()),
    }),
    {
      name: 'rs-draft',
      version: 1,
      storage: createJSONStorage(() => AsyncStorage),
      partialize: (state): DraftData => ({
        idempotencyKey: state.idempotencyKey,
        products: state.products,
        commonRefs: state.commonRefs,
        productRefs: state.productRefs,
      }),
    },
  ),
);
