import { useEffect, useSyncExternalStore } from 'react';
import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';
import { allDraftRefs, emptyDraft, findRef, partializeDraft, refsOf, restoreDraft, withRefs } from './draftData';
import { browserDraftStorage, guardStorage, type SyncStorage } from './draftStorage';
import type { DraftData, DraftReference, DraftState } from './draftTypes';
import { fileRegistry, type FileRegistry } from './fileRegistry';
import { clampSelection, toggleSelection } from './selection';

export const DRAFT_STORAGE_KEY = 'rs-draft';
export const DRAFT_VERSION = 1;

export interface DraftStoreOptions {
  // Defaults to localStorage (a no-op on the server). Tests pass an in-memory storage.
  storage?: SyncStorage;
  // Defaults to the shared registry that holds the File of every slot being uploaded.
  files?: FileRegistry;
}

// The store is created with skipHydration: nothing is read from storage until useDraftHydration (or
// hydrateDraft) runs on the client, so the server render and the first client render agree.
export function createDraftStore(options: DraftStoreOptions = {}) {
  const files = options.files ?? fileRegistry;
  const forget = (refs: readonly DraftReference[]): void => {
    for (const ref of refs) files.delete(ref.clientId);
  };

  return create<DraftState>()(
    persist<DraftState, [], [], DraftData>(
      (set, get) => ({
        ...emptyDraft(),

        bindShop: (shopId) => {
          const state = get();
          if (state.shopId === shopId) return;
          if (state.shopId === null) {
            set({ shopId });
            return;
          }
          forget(allDraftRefs(state));
          set({ ...emptyDraft(), shopId });
        },

        toggleProduct: (product, maxProducts) => {
          const { products, result } = toggleSelection(get().products, product, maxProducts);
          if (result !== 'limit') set({ products });
          return result;
        },

        setProducts: (products, maxProducts) => {
          const clamped = clampSelection(products, maxProducts);
          set({ products: clamped.products });
          return clamped.dropped;
        },

        clearSelection: () => set({ products: [] }),

        addRef: (target, ref) => {
          const state = get();
          set(withRefs(state, target, [...refsOf(state, target), ref]));
        },

        updateRef: (clientId, patch) => {
          const state = get();
          const found = findRef(state, clientId);
          if (found === null) return;
          // The bytes are not needed once the server has the file: no retry of a ready slot.
          if (patch.status === 'ready') files.delete(clientId);
          const next = { ...found.ref, ...patch, clientId };
          set(
            withRefs(
              state,
              found.target,
              refsOf(state, found.target).map((ref) => (ref.clientId === clientId ? next : ref)),
            ),
          );
        },

        removeRef: (clientId) => {
          const state = get();
          const found = findRef(state, clientId);
          if (found === null) return;
          files.delete(clientId);
          set(
            withRefs(
              state,
              found.target,
              refsOf(state, found.target).filter((ref) => ref.clientId !== clientId),
            ),
          );
        },

        setRefs: (target, refs) => {
          const state = get();
          const kept = new Set(refs.map((ref) => ref.clientId));
          forget(refsOf(state, target).filter((ref) => !kept.has(ref.clientId)));
          set(withRefs(state, target, refs));
        },

        reset: () => {
          const state = get();
          forget(allDraftRefs(state));
          set({ ...emptyDraft(), shopId: state.shopId });
        },
      }),
      {
        name: DRAFT_STORAGE_KEY,
        version: DRAFT_VERSION,
        storage: createJSONStorage<DraftData>(() =>
          options.storage === undefined ? browserDraftStorage() : guardStorage(options.storage),
        ),
        skipHydration: true,
        partialize: partializeDraft,
        merge: restoreDraft,
        // A draft of another version is discarded rather than guessed at.
        migrate: () => emptyDraft(),
      },
    ),
  );
}

export type DraftStore = ReturnType<typeof createDraftStore>;

export const useDraftStore = createDraftStore();

const hydrations = new WeakMap<DraftStore, Promise<void>>();

// Reads the persisted draft once per store. Calling it again returns the same promise, because a second
// rehydrate would overwrite uploads that are running with their last saved state.
export function hydrateDraft(store: DraftStore = useDraftStore): Promise<void> {
  let pending = hydrations.get(store);
  if (pending === undefined) {
    pending = Promise.resolve(store.persist.rehydrate()).then(() => undefined);
    hydrations.set(store, pending);
  }
  return pending;
}

const subscribeToHydration = (onChange: () => void): (() => void) => useDraftStore.persist.onFinishHydration(onChange);
const hasHydrated = (): boolean => useDraftStore.persist.hasHydrated();
const notHydratedOnServer = (): boolean => false;

// Starts hydration on the client and is true once the persisted draft has been read. Pages should show a
// skeleton (not the draft) until then.
export function useDraftHydration(): boolean {
  const hydrated = useSyncExternalStore(subscribeToHydration, hasHydrated, notHydratedOnServer);
  useEffect(() => {
    void hydrateDraft();
  }, []);
  return hydrated;
}

// A failed slot can start over only while its File is still in memory. After a reload it can only be removed.
export function canRetry(ref: DraftReference, files: FileRegistry = fileRegistry): boolean {
  return ref.status === 'failed' && files.has(ref.clientId);
}
