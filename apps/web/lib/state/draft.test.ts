import { describe, expect, it } from 'vitest';
import { canRetry, createDraftStore, DRAFT_STORAGE_KEY, hydrateDraft } from './draft';
import { INTERRUPTED_MESSAGE } from './draftData';
import { createMemoryStorage } from './draftStorage';
import type { DraftProduct, DraftReference } from './draftTypes';
import { createFileRegistry } from './fileRegistry';

function product(id: string): DraftProduct {
  return { id: `gid://shopify/Product/${id}`, title: `Product ${id}`, imageUrl: null };
}

function ref(clientId: string, patch: Partial<DraftReference> = {}): DraftReference {
  return {
    clientId,
    mediaId: null,
    mediaType: 'image',
    filename: `${clientId}.jpg`,
    mimeType: 'image/jpeg',
    fileSize: 1000,
    durationSec: null,
    status: 'uploading',
    progress: 0,
    previewUrl: null,
    error: null,
    ...patch,
  };
}

function file(name: string): File {
  return new File(['x'], name, { type: 'image/jpeg' });
}

function setup() {
  const storage = createMemoryStorage();
  const files = createFileRegistry();
  const store = createDraftStore({ storage, files });
  return { storage, files, store, state: () => store.getState() };
}

describe('selection', () => {
  it('toggles products and stops at the cap', () => {
    const { state } = setup();
    expect(state().toggleProduct(product('1'), 2)).toBe('added');
    expect(state().toggleProduct(product('2'), 2)).toBe('added');
    expect(state().toggleProduct(product('3'), 2)).toBe('limit');
    expect(state().products.map((p) => p.title)).toEqual(['Product 1', 'Product 2']);
    expect(state().toggleProduct(product('1'), 2)).toBe('removed');
    expect(state().products.map((p) => p.title)).toEqual(['Product 2']);
  });

  it('setProducts removes duplicates and cuts to the cap', () => {
    const { state } = setup();
    const dropped = state().setProducts([product('1'), product('2'), product('1'), product('3')], 2);
    expect(dropped).toBe(1);
    expect(state().products.map((p) => p.id)).toEqual([product('1').id, product('2').id]);
  });

  it('clearSelection keeps the references of the products', () => {
    const { state } = setup();
    state().toggleProduct(product('1'), 5);
    state().addRef({ kind: 'product', productId: product('1').id }, ref('a'));
    state().clearSelection();
    expect(state().products).toEqual([]);
    expect(state().productRefs[product('1').id]).toHaveLength(1);
  });
});

describe('references', () => {
  it('adds, updates and removes common and product references', () => {
    const { state, files } = setup();
    const gid = product('1').id;
    state().addRef({ kind: 'common' }, ref('c1'));
    state().addRef({ kind: 'product', productId: gid }, ref('p1'));
    state().addRef({ kind: 'product', productId: gid }, ref('p2'));
    files.set('p1', file('p1.jpg'));

    state().updateRef('p1', { status: 'processing', progress: 1, mediaId: 'm1' });
    expect(state().productRefs[gid]?.[0]).toMatchObject({ clientId: 'p1', status: 'processing', mediaId: 'm1' });
    expect(files.has('p1')).toBe(true);

    state().removeRef('p1');
    expect(state().productRefs[gid]?.map((r) => r.clientId)).toEqual(['p2']);
    expect(files.has('p1')).toBe(false);

    state().removeRef('p2');
    expect(state().productRefs).toEqual({});
    state().removeRef('c1');
    expect(state().commonRefs).toEqual([]);
  });

  it('ignores updates for an unknown slot and never changes the clientId', () => {
    const { state } = setup();
    state().addRef({ kind: 'common' }, ref('c1'));
    const before = state().commonRefs;
    state().updateRef('missing', { progress: 0.5 });
    expect(state().commonRefs).toBe(before);
    state().updateRef('c1', { clientId: 'other' } as never);
    expect(state().commonRefs[0]?.clientId).toBe('c1');
  });

  it('drops the File once a slot is ready', () => {
    const { state, files } = setup();
    state().addRef({ kind: 'common' }, ref('c1'));
    files.set('c1', file('c1.jpg'));
    state().updateRef('c1', { status: 'ready' });
    expect(files.has('c1')).toBe(false);
  });

  it('setRefs replaces the list and forgets the Files that left', () => {
    const { state, files } = setup();
    state().addRef({ kind: 'common' }, ref('a'));
    state().addRef({ kind: 'common' }, ref('b'));
    files.set('a', file('a.jpg'));
    files.set('b', file('b.jpg'));
    state().setRefs({ kind: 'common' }, [ref('b'), ref('c')]);
    expect(state().commonRefs.map((r) => r.clientId)).toEqual(['b', 'c']);
    expect(files.has('a')).toBe(false);
    expect(files.has('b')).toBe(true);
  });
});

describe('shop binding and reset', () => {
  it('claims an unbound draft, keeps it for the same shop and clears it for another', () => {
    const { state, files } = setup();
    state().toggleProduct(product('1'), 5);
    state().addRef({ kind: 'common' }, ref('c1'));
    files.set('c1', file('c1.jpg'));
    const key = state().idempotencyKey;

    state().bindShop('shop-a');
    expect(state().shopId).toBe('shop-a');
    expect(state().products).toHaveLength(1);

    state().bindShop('shop-a');
    expect(state().commonRefs).toHaveLength(1);

    state().bindShop('shop-b');
    expect(state().shopId).toBe('shop-b');
    expect(state().products).toEqual([]);
    expect(state().commonRefs).toEqual([]);
    expect(state().idempotencyKey).not.toBe(key);
    expect(files.has('c1')).toBe(false);
  });

  it('reset issues a new idempotency key and keeps the shop', () => {
    const { state, files } = setup();
    state().bindShop('shop-a');
    state().addRef({ kind: 'common' }, ref('c1'));
    files.set('c1', file('c1.jpg'));
    const key = state().idempotencyKey;
    state().reset();
    expect(state().idempotencyKey).not.toBe(key);
    expect(state().shopId).toBe('shop-a');
    expect(state().commonRefs).toEqual([]);
    expect(files.has('c1')).toBe(false);
  });

  it('uses a uuid shaped idempotency key', () => {
    const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
    expect(setup().state().idempotencyKey).toMatch(uuid);
  });
});

describe('persistence', () => {
  it('does not read the storage until hydrated', () => {
    const { storage, store } = setup();
    storage.setItem(DRAFT_STORAGE_KEY, JSON.stringify({ state: { shopId: 'x' }, version: 1 }));
    expect(store.getState().shopId).toBeNull();
    expect(store.persist.hasHydrated()).toBe(false);
  });

  it('writes the data and no actions', () => {
    const { storage, state } = setup();
    state().bindShop('shop-a');
    const saved = JSON.parse(storage.getItem(DRAFT_STORAGE_KEY) as string) as { state: object; version: number };
    expect(saved.version).toBe(1);
    expect(Object.keys(saved.state).sort()).toEqual(
      ['commonRefs', 'idempotencyKey', 'productRefs', 'products', 'shopId'].sort(),
    );
  });

  it('restores the draft and settles interrupted uploads', async () => {
    const first = setup();
    const gid = product('1').id;
    first.state().bindShop('shop-a');
    first.state().toggleProduct(product('1'), 5);
    first.state().addRef({ kind: 'common' }, ref('c1', { status: 'ready', mediaId: 'm1', progress: 1 }));
    first.state().addRef({ kind: 'common' }, ref('c2', { status: 'uploading', progress: 0.4, mediaId: 'm2' }));
    const own = { kind: 'product', productId: gid } as const;
    first.state().addRef(own, ref('p1', { status: 'processing', mediaId: 'm3', progress: 1 }));
    first.state().addRef(own, ref('p2', { status: 'failed', error: 'nope' }));

    const files = createFileRegistry();
    const second = createDraftStore({ storage: first.storage, files });
    await hydrateDraft(second);

    const restored = second.getState();
    expect(second.persist.hasHydrated()).toBe(true);
    expect(restored.idempotencyKey).toBe(first.state().idempotencyKey);
    expect(restored.shopId).toBe('shop-a');
    expect(restored.products.map((p) => p.id)).toEqual([gid]);
    expect(restored.commonRefs[0]).toMatchObject({ clientId: 'c1', status: 'ready', mediaId: 'm1' });
    expect(restored.commonRefs[1]).toMatchObject({
      clientId: 'c2',
      status: 'failed',
      progress: 0,
      error: INTERRUPTED_MESSAGE,
      mediaId: 'm2',
    });
    expect(restored.productRefs[gid]?.[0]).toMatchObject({ status: 'processing', mediaId: 'm3' });
    expect(restored.productRefs[gid]?.[1]).toMatchObject({ status: 'failed', error: 'nope' });

    // The Files are gone after a reload: a failed slot can only be removed.
    expect(canRetry(restored.commonRefs[1] as DraftReference, files)).toBe(false);
    files.set('c2', file('c2.jpg'));
    expect(canRetry(restored.commonRefs[1] as DraftReference, files)).toBe(true);
    expect(canRetry(restored.commonRefs[0] as DraftReference, files)).toBe(false);
  });

  it('fails a processing slot that has no media id to poll', async () => {
    const first = setup();
    first.state().addRef({ kind: 'common' }, ref('c1', { status: 'processing', mediaId: null }));
    const second = createDraftStore({ storage: first.storage, files: createFileRegistry() });
    await hydrateDraft(second);
    expect(second.getState().commonRefs[0]).toMatchObject({ status: 'failed', error: INTERRUPTED_MESSAGE });
  });

  it('hydrates only once per store', async () => {
    const { store, state } = setup();
    await hydrateDraft(store);
    state().bindShop('shop-a');
    state().addRef({ kind: 'common' }, ref('c1', { status: 'uploading', progress: 0.5 }));
    await hydrateDraft(store);
    expect(state().commonRefs[0]?.status).toBe('uploading');
  });

  it('keeps an empty draft when the stored value is garbage or from another version', async () => {
    for (const raw of ['not json', '{"state":{"products":"x"},"version":1}', '{"state":{"shopId":"x"},"version":9}']) {
      const storage = createMemoryStorage();
      storage.setItem(DRAFT_STORAGE_KEY, raw);
      const store = createDraftStore({ storage, files: createFileRegistry() });
      await hydrateDraft(store);
      expect(store.persist.hasHydrated()).toBe(true);
      expect(store.getState().products).toEqual([]);
      expect(store.getState().commonRefs).toEqual([]);
    }
  });

  it('keeps working when the storage throws', () => {
    const storage = {
      getItem: () => {
        throw new Error('blocked');
      },
      setItem: () => {
        throw new Error('quota');
      },
      removeItem: () => undefined,
    };
    const store = createDraftStore({ storage });
    store.getState().toggleProduct(product('1'), 5);
    expect(store.getState().products).toHaveLength(1);
  });
});
