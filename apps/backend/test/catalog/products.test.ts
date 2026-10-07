import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { productDetailSchema, productListResponseSchema, productSnapshotSchema } from '@rs/shared';
import { AppError } from '../../src/core/errors';
import { createCatalogModule } from '../../src/modules/catalog';
import { createMockAdmin, createTestApp, fakeRequireAuth, productGid, silentLogger, SHOP_ID, type RecordedCall } from './kit';

function snapshotNode(n: number, overrides: Record<string, unknown> = {}) {
  return {
    id: productGid(n),
    title: `Lamp ${n}`,
    handle: `lamp-${n}`,
    descriptionHtml: '<p>A <strong>ceramic</strong> lamp &amp; shade.</p><p>Warm light.</p>',
    productType: 'Lighting',
    vendor: 'Acme',
    tags: ['home', 'lamp'],
    options: [{ name: 'Color', values: ['Blue', 'White'] }],
    featuredMedia: { preview: { image: { url: 'https://cdn.shopify.com/s/files/1/0001/lamp-featured.jpg?v=17' } } },
    media: {
      nodes: [
        { image: { url: 'https://cdn.shopify.com/s/files/1/0001/lamp-1.jpg?v=1' } },
        {},
        { image: { url: 'https://cdn.shopify.com/s/files/1/0001/lamp-2.jpg' } },
        { image: { url: 'https://cdn.shopify.com/s/files/1/0001/lamp-3.jpg' } },
        { image: { url: 'https://cdn.shopify.com/s/files/1/0001/lamp-4.jpg' } },
        { image: { url: 'https://cdn.shopify.com/s/files/1/0001/lamp-5.jpg' } },
        { image: { url: 'https://cdn.shopify.com/s/files/1/0001/lamp-6.jpg' } },
      ],
    },
    ...overrides,
  };
}

function listNode(n: number, overrides: Record<string, unknown> = {}) {
  return {
    id: productGid(n),
    title: `Lamp ${n}`,
    handle: `lamp-${n}`,
    status: 'ACTIVE',
    vendor: 'Acme',
    productType: 'Lighting',
    featuredMedia: { preview: { image: { url: `https://cdn.shopify.com/lamp-${n}.jpg` } } },
    mediaCount: { count: 4 },
    variantsCount: { count: 2 },
    ...overrides,
  };
}

function respondWith(handlers: { list?: unknown; detail?: unknown; snapshots?: (call: RecordedCall) => unknown }) {
  return (call: RecordedCall): unknown => {
    if (call.query.includes('query ProductList')) return handlers.list;
    if (call.query.includes('query ProductDetail')) return handlers.detail;
    if (call.query.includes('query ProductSnapshots')) return handlers.snapshots?.(call);
    throw new Error(`unexpected query: ${call.query}`);
  };
}

describe('catalog service', () => {
  it('lists products in the shared contract shape and maps pageInfo', async () => {
    const { admin, calls } = createMockAdmin(
      respondWith({
        list: {
          products: {
            nodes: [listNode(1), listNode(2, { featuredMedia: null, mediaCount: null, variantsCount: null, status: 'DRAFT' })],
            pageInfo: { hasNextPage: true, endCursor: 'cursor-2' },
          },
        },
      }),
    );
    const { service } = createCatalogModule({ admin, requireAuth: fakeRequireAuth, logger: silentLogger });

    const result = await service.listProducts(SHOP_ID, { limit: 2 });

    expect(productListResponseSchema.parse(result)).toEqual(result);
    expect(result.pageInfo).toEqual({ endCursor: 'cursor-2', hasNextPage: true });
    expect(result.items[0]).toEqual({
      id: productGid(1),
      title: 'Lamp 1',
      handle: 'lamp-1',
      status: 'ACTIVE',
      vendor: 'Acme',
      productType: 'Lighting',
      imageUrl: 'https://cdn.shopify.com/lamp-1.jpg',
      mediaCount: 4,
      variantsCount: 2,
    });
    expect(result.items[1]).toMatchObject({ status: 'DRAFT', imageUrl: null, mediaCount: 0, variantsCount: 0 });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.shopId).toBe(SHOP_ID);
    expect(calls[0]?.query).toContain('sortKey: UPDATED_AT');
    expect(calls[0]?.query).toContain('reverse: true');
    expect(calls[0]?.variables).toEqual({ first: 2, after: null, query: null });
  });

  it('passes the cursor and a title-scoped, escaped search to Shopify', async () => {
    const { admin, calls } = createMockAdmin(
      respondWith({ list: { products: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } } } }),
    );
    const { service } = createCatalogModule({ admin, requireAuth: fakeRequireAuth, logger: silentLogger });

    await service.listProducts(SHOP_ID, { limit: 25, cursor: 'abc', q: 'blue status:draft' });

    expect(calls[0]?.variables).toEqual({ first: 25, after: 'abc', query: 'title:*blue* title:*status\\:draft*' });
  });

  it('returns the detail with plain text, five resized images and the gid', async () => {
    const { admin, calls } = createMockAdmin(respondWith({ detail: { product: snapshotNode(7) } }));
    const { service } = createCatalogModule({ admin, requireAuth: fakeRequireAuth, logger: silentLogger });

    const detail = await service.getProduct(SHOP_ID, productGid(7));

    expect(productDetailSchema.parse(detail)).toEqual(detail);
    expect(detail.id).toBe(productGid(7));
    expect(detail.descriptionText).toBe('A ceramic lamp & shade.\nWarm light.');
    expect(detail.tags).toEqual(['home', 'lamp']);
    expect(detail.options).toEqual([{ name: 'Color', values: ['Blue', 'White'] }]);
    expect(detail.imageUrls).toHaveLength(5);
    expect(detail.imageUrls[0]).toBe('https://cdn.shopify.com/s/files/1/0001/lamp-1.jpg?v=1&width=1536');
    expect(detail.imageUrls[1]).toBe('https://cdn.shopify.com/s/files/1/0001/lamp-2.jpg?width=1536');
    expect(detail.featuredImageUrl).toBe('https://cdn.shopify.com/s/files/1/0001/lamp-featured.jpg?v=17&width=1536');
    expect(calls[0]?.variables).toEqual({ id: productGid(7) });
  });

  it('replaces an existing width parameter instead of adding a second one', async () => {
    const node = snapshotNode(8, { media: { nodes: [{ image: { url: 'https://cdn.shopify.com/a.jpg?width=100&v=2' } }] } });
    const { admin } = createMockAdmin(respondWith({ detail: { product: node } }));
    const { service } = createCatalogModule({ admin, requireAuth: fakeRequireAuth, logger: silentLogger });

    const detail = await service.getProduct(SHOP_ID, productGid(8));

    expect(detail.imageUrls).toEqual(['https://cdn.shopify.com/a.jpg?width=1536&v=2']);
  });

  it('handles a product without images or featured media', async () => {
    const node = snapshotNode(9, { featuredMedia: null, media: { nodes: [] }, descriptionHtml: '' });
    const { admin } = createMockAdmin(respondWith({ detail: { product: node } }));
    const { service } = createCatalogModule({ admin, requireAuth: fakeRequireAuth, logger: silentLogger });

    const detail = await service.getProduct(SHOP_ID, productGid(9));

    expect(detail).toMatchObject({ featuredImageUrl: null, imageUrls: [], descriptionText: '' });
  });

  it('throws not_found when the product does not exist and validation_failed for a malformed gid', async () => {
    const { admin, calls } = createMockAdmin(respondWith({ detail: { product: null } }));
    const { service } = createCatalogModule({ admin, requireAuth: fakeRequireAuth, logger: silentLogger });

    await expect(service.getProduct(SHOP_ID, productGid(404))).rejects.toMatchObject({ code: 'not_found' });
    await expect(service.getProduct(SHOP_ID, 'gid://shopify/Order/1')).rejects.toMatchObject({ code: 'validation_failed' });
    expect(calls).toHaveLength(1);
  });

  it('caps the stored description at 2000 characters', async () => {
    const node = snapshotNode(10, { descriptionHtml: `<p>${'x'.repeat(5000)}</p>` });
    const { admin } = createMockAdmin(respondWith({ detail: { product: node } }));
    const { service } = createCatalogModule({ admin, requireAuth: fakeRequireAuth, logger: silentLogger });

    const detail = await service.getProduct(SHOP_ID, productGid(10));

    expect(detail.descriptionText).toHaveLength(2000);
  });

  it('builds snapshots keyed by gid in the batch item shape', async () => {
    const { admin, calls } = createMockAdmin(
      respondWith({ snapshots: (call) => ({ nodes: (call.variables?.ids as string[]).map((gid) => snapshotNode(Number(gid.split('/').pop()))) }) }),
    );
    const { service } = createCatalogModule({ admin, requireAuth: fakeRequireAuth, logger: silentLogger });

    const snapshots = await service.snapshotProducts(SHOP_ID, [productGid(1), productGid(2), productGid(1)]);

    expect([...snapshots.keys()]).toEqual([productGid(1), productGid(2)]);
    const first = snapshots.get(productGid(1));
    expect(first).toBeDefined();
    expect(productSnapshotSchema.parse(first)).toEqual(first);
    expect(first).toMatchObject({ title: 'Lamp 1', handle: 'lamp-1', descriptionText: 'A ceramic lamp & shade.\nWarm light.' });
    expect(first).not.toHaveProperty('id');
    expect(calls).toHaveLength(1);
    expect(calls[0]?.variables).toEqual({ ids: [productGid(1), productGid(2)] });
  });

  it('splits large snapshot requests into several queries', async () => {
    const { admin, calls } = createMockAdmin(
      respondWith({ snapshots: (call) => ({ nodes: (call.variables?.ids as string[]).map((gid) => snapshotNode(Number(gid.split('/').pop()))) }) }),
    );
    const { service } = createCatalogModule({ admin, requireAuth: fakeRequireAuth, logger: silentLogger });
    const gids = Array.from({ length: 45 }, (_, i) => productGid(i + 1));

    const snapshots = await service.snapshotProducts(SHOP_ID, gids);

    expect(snapshots.size).toBe(45);
    expect(calls.map((call) => (call.variables?.ids as string[]).length)).toEqual([20, 20, 5]);
  });

  it('throws not_found listing every missing product, including null and non-product nodes', async () => {
    const { admin } = createMockAdmin(respondWith({ snapshots: () => ({ nodes: [snapshotNode(1), null, {}] }) }));
    const { service } = createCatalogModule({ admin, requireAuth: fakeRequireAuth, logger: silentLogger });

    const error = await service.snapshotProducts(SHOP_ID, [productGid(1), productGid(2), productGid(3)]).catch((err: unknown) => err);

    expect(error).toBeInstanceOf(AppError);
    expect(error).toMatchObject({ code: 'not_found', details: { productGids: [productGid(2), productGid(3)] } });
  });

  it('does not call Shopify for an empty snapshot request', async () => {
    const { admin, calls } = createMockAdmin(() => {
      throw new Error('should not be called');
    });
    const { service } = createCatalogModule({ admin, requireAuth: fakeRequireAuth, logger: silentLogger });

    expect((await service.snapshotProducts(SHOP_ID, [])).size).toBe(0);
    expect(calls).toHaveLength(0);
  });

  it('turns an unexpected Shopify payload into an internal error', async () => {
    const { admin } = createMockAdmin(respondWith({ detail: { product: { id: productGid(1) } } }));
    const { service } = createCatalogModule({ admin, requireAuth: fakeRequireAuth, logger: silentLogger });

    await expect(service.getProduct(SHOP_ID, productGid(1))).rejects.toMatchObject({ code: 'internal' });
  });
});

describe('catalog routes', () => {
  function buildApp(handlers: Parameters<typeof respondWith>[0]) {
    const mock = createMockAdmin(respondWith(handlers));
    const { router } = createCatalogModule({ admin: mock.admin, requireAuth: fakeRequireAuth, logger: silentLogger });
    const app = createTestApp((instance) => instance.use('/api/v1', router));
    return { app, calls: mock.calls };
  }

  const emptyList = { products: { nodes: [listNode(1)], pageInfo: { hasNextPage: false, endCursor: null } } };

  it('requires authentication', async () => {
    const { app, calls } = buildApp({ list: emptyList });

    const response = await request(app).get('/api/v1/products');

    expect(response.status).toBe(401);
    expect(calls).toHaveLength(0);
  });

  it('lists products for the authenticated shop with the default limit', async () => {
    const { app, calls } = buildApp({ list: emptyList });

    const response = await request(app).get('/api/v1/products?q=lamp').set('x-test-shop', SHOP_ID);

    expect(response.status).toBe(200);
    expect(productListResponseSchema.parse(response.body).items).toHaveLength(1);
    expect(calls[0]?.shopId).toBe(SHOP_ID);
    expect(calls[0]?.variables).toEqual({ first: 25, after: null, query: 'title:*lamp*' });
  });

  it('validates the list query with the shared schema', async () => {
    const { app, calls } = buildApp({ list: emptyList });

    const tooMany = await request(app).get('/api/v1/products?limit=51').set('x-test-shop', SHOP_ID);
    const notNumber = await request(app).get('/api/v1/products?limit=abc').set('x-test-shop', SHOP_ID);

    expect(tooMany.status).toBe(400);
    expect(tooMany.body.error.code).toBe('validation_failed');
    expect(notNumber.status).toBe(400);
    expect(calls).toHaveLength(0);
  });

  it('serves the detail for a url-encoded gid', async () => {
    const { app, calls } = buildApp({ detail: { product: snapshotNode(5) } });

    const response = await request(app).get(`/api/v1/products/${encodeURIComponent(productGid(5))}`).set('x-test-shop', SHOP_ID);

    expect(response.status).toBe(200);
    expect(productDetailSchema.parse(response.body).id).toBe(productGid(5));
    expect(calls[0]?.variables).toEqual({ id: productGid(5) });
  });

  it('answers 404 for a product Shopify does not return and 400 for a malformed or foreign gid', async () => {
    const { app } = buildApp({ detail: { product: null } });

    const missing = await request(app).get(`/api/v1/products/${encodeURIComponent(productGid(404))}`).set('x-test-shop', SHOP_ID);
    const foreign = await request(app).get(`/api/v1/products/${encodeURIComponent('gid://shopify/Order/1')}`).set('x-test-shop', SHOP_ID);
    const junk = await request(app).get('/api/v1/products/not-a-gid').set('x-test-shop', SHOP_ID);

    expect(missing.status).toBe(404);
    expect(missing.body.error.code).toBe('not_found');
    expect(foreign.status).toBe(400);
    expect(foreign.body.error.code).toBe('validation_failed');
    expect(junk.status).toBe(400);
  });
});
