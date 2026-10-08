import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  meResponseSchema,
  productDetailSchema,
  productListResponseSchema,
  type Api,
  type ProductListItem,
  type ProductListParams,
} from '@rs/shared';
import { createMockApi, resetMockApi } from '../src';
import { PRODUCTS, toListItem } from '../src/fixtures';
import { productGid } from '../src/util';
import { cleanup, expectApiError, freshApi } from './helpers';

let api: Api;
beforeEach(() => {
  api = freshApi();
});
afterEach(cleanup);

async function listAll(params: ProductListParams): Promise<ProductListItem[]> {
  const items: ProductListItem[] = [];
  let cursor: string | undefined;
  do {
    const page = productListResponseSchema.parse(await api.products.list({ ...params, cursor, limit: 50 }));
    items.push(...page.items);
    cursor = page.pageInfo.hasNextPage ? (page.pageInfo.endCursor ?? undefined) : undefined;
  } while (cursor !== undefined);
  return items;
}

describe('me', () => {
  it('returns the user, shop and generation limits', async () => {
    const me = meResponseSchema.parse(await api.me());
    expect(me.shop.domain).toBe('mock-store.myshopify.com');
    expect(me.generation.imagesPerProduct).toBe(2);
    expect(me.generation.maxProductsPerBatch).toBe(50);
  });
});

describe('products', () => {
  it('pages through the 42 products that have an image with a cursor', async () => {
    const titles: string[] = [];
    let cursor: string | undefined;
    let pages = 0;
    do {
      const page = productListResponseSchema.parse(await api.products.list({ cursor, limit: 20 }));
      titles.push(...page.items.map((item) => item.title));
      cursor = page.pageInfo.hasNextPage ? (page.pageInfo.endCursor ?? undefined) : undefined;
      pages += 1;
    } while (cursor !== undefined);
    expect(pages).toBe(3);
    expect(titles).toHaveLength(42);
    expect(new Set(titles).size).toBe(42);
  });

  it('never lists a product without an image, but still serves its detail', async () => {
    const listed = await listAll({});
    expect(listed.every((item) => item.imageUrl !== null)).toBe(true);
    const imageless = PRODUCTS.filter((product) => product.featuredImageUrl === null);
    expect(imageless).toHaveLength(3);
    for (const product of imageless) {
      expect(listed.map((item) => item.id)).not.toContain(product.id);
      expect(productDetailSchema.parse(await api.products.get(product.id)).imageUrls).toEqual([]);
    }
    // An imageless product reports no media either.
    const items = PRODUCTS.map((product, index) => toListItem(product, index));
    expect(items.filter((item) => item.imageUrl === null).map((item) => item.mediaCount)).toEqual([0, 0, 0]);
  });

  it('filters by status, case insensitively, on top of the image rule', async () => {
    const active = await listAll({ status: 'active' });
    const draft = await listAll({ status: 'draft' });
    expect(active.every((item) => item.status === 'ACTIVE')).toBe(true);
    expect(draft.every((item) => item.status === 'DRAFT')).toBe(true);
    expect(active).toHaveLength(33);
    expect(draft).toHaveLength(8);
    expect(await listAll({ status: 'DRAFT' as 'draft' })).toEqual(draft);
    // The 45 fixtures have 3 products without an image (two active, one draft) and one archived product.
    const all = await listAll({});
    expect(all).toHaveLength(42);
    expect(all.filter((item) => item.status === 'ARCHIVED')).toHaveLength(1);
  });

  it('pages a status filtered list with a cursor and combines it with a search', async () => {
    const first = productListResponseSchema.parse(await api.products.list({ status: 'active', limit: 20 }));
    expect(first.items).toHaveLength(20);
    expect(first.pageInfo.hasNextPage).toBe(true);
    const second = productListResponseSchema.parse(
      await api.products.list({ status: 'active', limit: 20, cursor: first.pageInfo.endCursor ?? undefined }),
    );
    expect(second.items).toHaveLength(13);
    expect(second.pageInfo).toEqual({ endCursor: '33', hasNextPage: false });

    const lamp = await api.products.list({ status: 'draft', q: 'lamp' });
    expect(lamp.items).toEqual([]);
  });

  it('searches by title, case insensitive, and finds nothing for zzz', async () => {
    const found = productListResponseSchema.parse(await api.products.list({ q: '  LAMP ' }));
    expect(found.items.map((item) => item.title)).toEqual(['Ceramic Table Lamp']);
    const none = productListResponseSchema.parse(await api.products.list({ q: 'zzz' }));
    expect(none).toEqual({ items: [], pageInfo: { endCursor: null, hasNextPage: false } });
  });

  it('fails the list for the "error" demo search', async () => {
    await expectApiError(api.products.list({ q: 'error' }), 'internal');
  });

  it('returns a product detail and 404s for an unknown gid', async () => {
    const product = productDetailSchema.parse(await api.products.get(productGid(0)));
    expect(product.title).toBe('Ceramic Table Lamp');
    await expectApiError(api.products.get(productGid(999)), 'not_found');
  });
});

describe('singleton state', () => {
  it('is shared by every api instance until reset', async () => {
    const other = createMockApi({ latencyMs: 0 });
    const created = await api.batches.create({
      idempotencyKey: '0b1f6a54-4a4f-4d0e-9d3e-5d1c8f2f7a10',
      products: [{ productGid: productGid(0) }],
      commonReferenceMediaIds: ['0'.repeat(24)],
    });
    expect((await other.batches.get(created.id)).id).toBe(created.id);

    resetMockApi();
    await expectApiError(other.batches.get(created.id), 'not_found');
  });
});
