import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { meResponseSchema, productDetailSchema, productListResponseSchema, type Api } from '@rs/shared';
import { createMockApi, resetMockApi } from '../src';
import { productGid } from '../src/util';
import { cleanup, expectApiError, freshApi } from './helpers';

let api: Api;
beforeEach(() => {
  api = freshApi();
});
afterEach(cleanup);

describe('me', () => {
  it('returns the user, shop and generation limits', async () => {
    const me = meResponseSchema.parse(await api.me());
    expect(me.shop.domain).toBe('mock-store.myshopify.com');
    expect(me.generation.imagesPerProduct).toBe(2);
    expect(me.generation.maxProductsPerBatch).toBe(50);
  });
});

describe('products', () => {
  it('pages through the 45 fixtures with a cursor', async () => {
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
    expect(titles).toHaveLength(45);
    expect(new Set(titles).size).toBe(45);
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
