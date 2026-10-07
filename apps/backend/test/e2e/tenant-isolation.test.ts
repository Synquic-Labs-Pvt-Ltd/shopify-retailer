import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  batchListResponseSchema,
  batchSummarySchema,
  mediaListResponseSchema,
  productListResponseSchema,
  type BatchDetail,
  type MediaObject,
} from '@rs/shared';
import { FAKE_JPEG, FAKE_MP4 } from '../../src/modules/ai/fake-media';
import { MediaAssetModel } from '../../src/modules/media/models';
import { UserModel } from '../../src/modules/auth/models';
import { commonImageSpec, createBatch, defined, errorOf, getBatch, login, uploadReadyReferences, type ApiClient } from './support/client';
import { MONGO_START_TIMEOUT_MS, startE2e, type E2e } from './support/harness';

const SHOP_A = 'north-store.myshopify.com';
const SHOP_B = 'south-store.myshopify.com';

let e2e: E2e;
let a: ApiClient;
let b: ApiClient;
let aGids: string[] = [];
let bGids: string[] = [];
let aRefs: MediaObject[] = [];
let bRefs: MediaObject[] = [];
let aBatch = '';
let bBatch = '';
let aDetail: BatchDetail;

beforeAll(async () => {
  e2e = await startE2e({ dbName: 'rs_e2e_tenants' });
  e2e.stub.addShop(SHOP_A);
  e2e.stub.addShop(SHOP_B);
  // The same Shopify staff member id exists in both stores.
  a = await login(e2e, SHOP_A);
  b = await login(e2e, SHOP_B);
  aGids = e2e.stub.shop(SHOP_A).products.map((product) => product.id);
  bGids = e2e.stub.shop(SHOP_B).products.map((product) => product.id);
  aRefs = await uploadReadyReferences(a, [commonImageSpec('a-common', FAKE_JPEG)]);
  bRefs = await uploadReadyReferences(b, [commonImageSpec('b-common', FAKE_JPEG)]);
}, MONGO_START_TIMEOUT_MS);

afterAll(async () => {
  await e2e.stop();
});

const aRef = (): MediaObject => defined(aRefs[0]);
const bRef = (): MediaObject => defined(bRefs[0]);

describe('two merchants share the backend', () => {
  it('log in as separate users even when Shopify staff ids collide', async () => {
    expect(a.session.user.id).not.toBe(b.session.user.id);
    expect(a.session.shop.id).not.toBe(b.session.shop.id);
    expect(await UserModel.countDocuments({ shopifyUserId: '902541635' })).toBe(2);
    expect((await a.get('/api/v1/me')).body.shop.domain).toBe(SHOP_A);
    expect((await b.get('/api/v1/me')).body.shop.domain).toBe(SHOP_B);
  });

  it('generate side by side, each with their own catalog, references and Shopify files', async () => {
    const [aRes, bRes] = await Promise.all([
      createBatch(a, { products: [{ productGid: defined(aGids[0]) }, { productGid: defined(aGids[1]) }], commonReferenceMediaIds: [aRef().id] }),
      createBatch(b, { products: [{ productGid: defined(bGids[0]) }], commonReferenceMediaIds: [bRef().id] }),
    ]);
    expect([aRes.status, bRes.status]).toEqual([201, 201]);
    aBatch = batchSummarySchema.parse(aRes.body).id;
    bBatch = batchSummarySchema.parse(bRes.body).id;

    await e2e.drive(async () => {
      const [first, second] = await Promise.all([getBatch(a, aBatch), getBatch(b, bBatch)]);
      return ['completed', 'completed_with_errors', 'failed', 'cancelled'].includes(first.status) && ['completed', 'completed_with_errors', 'failed', 'cancelled'].includes(second.status);
    }, { timeoutMs: 60_000, intervalMs: 300 });
    await e2e.settle();

    aDetail = await getBatch(a, aBatch);
    const bDetail = await getBatch(b, bBatch);
    expect(aDetail).toMatchObject({ status: 'completed', counts: { products: 2, imagesReady: 4, videosReady: 2 } });
    expect(bDetail).toMatchObject({ status: 'completed', counts: { products: 1, imagesReady: 2, videosReady: 1 } });
    expect(aDetail.items.map((item) => item.productGid)).toEqual(aGids.slice(0, 2));
    expect(bDetail.items.map((item) => item.productGid)).toEqual(bGids.slice(0, 1));

    // Each store received exactly its own references and outputs.
    expect(e2e.stub.shop(SHOP_A).files.size).toBe(1 + 6);
    expect(e2e.stub.shop(SHOP_B).files.size).toBe(1 + 3);
    const owned = async (client: ApiClient) => MediaAssetModel.countDocuments({ shopId: client.session.shop.id });
    expect([await owned(a), await owned(b)]).toEqual([7, 4]);
    expect(e2e.stub.shop(SHOP_A).files.size + e2e.stub.shop(SHOP_B).files.size).toBe(await MediaAssetModel.countDocuments());

    // Every Admin call carried the token of its own store, and the stores never shared one.
    const tokens = (domain: string) => new Set(e2e.stub.state.calls.flatMap((call) => (call.kind === 'graphql' && call.shop === domain ? [call.token] : [])));
    const shared = [...tokens(SHOP_A)].filter((token) => tokens(SHOP_B).has(token));
    expect(shared).toEqual([]);
    expect(e2e.stub.state.unexpected).toEqual([]);
  }, 90_000);
});

describe('one merchant cannot see or use what the other owns', () => {
  it('lists only its own products, and cannot read or batch the other store products', async () => {
    const own = productListResponseSchema.parse((await b.get('/api/v1/products?limit=50')).body).items.map((item) => item.id);
    expect(own).toEqual(bGids);
    expect(own.some((id) => aGids.includes(id))).toBe(false);

    const read = await b.get(`/api/v1/products/${encodeURIComponent(defined(aGids[0]))}`);
    expect(read.status).toBe(404);
    const batched = await createBatch(b, { products: [{ productGid: defined(aGids[0]) }], commonReferenceMediaIds: [bRef().id] });
    expect(batched.status).toBe(404);
    expect(errorOf(batched).details).toEqual({ productGids: [aGids[0]] });
  });

  it('cannot reach the other batches', async () => {
    const list = batchListResponseSchema.parse((await b.get('/api/v1/batches')).body);
    expect(list.items.map((item) => item.id)).toEqual([bBatch]);
    for (const [method, path] of [
      ['get', `/api/v1/batches/${aBatch}`],
      ['post', `/api/v1/batches/${aBatch}/cancel`],
      ['post', `/api/v1/batches/${aBatch}/retry-failed`],
    ] as const) {
      const res = await (method === 'get' ? b.get(path) : b.post(path));
      expect([method, path, res.status]).toEqual([method, path, 404]);
      expect(errorOf(res).code).toBe('not_found');
    }
    // Nothing happened to the batch of the other shop.
    expect((await getBatch(a, aBatch)).status).toBe('completed');
  });

  it('cannot read, complete, delete or build on the other media', async () => {
    const outputIds = aDetail.items.flatMap((item) => item.outputs.map((output) => output.id));
    const aIds = [aRef().id, ...outputIds];
    expect(aIds).toHaveLength(7);

    const listed = await b.get(`/api/v1/media?ids=${aIds.join(',')}`);
    expect(listed.status).toBe(200);
    expect(mediaListResponseSchema.parse(listed.body).items).toEqual([]);
    expect(mediaListResponseSchema.parse((await b.get(`/api/v1/media?ids=${[bRef().id, ...aIds].join(',')}`)).body).items.map((item) => item.id)).toEqual([bRef().id]);

    for (const id of aIds.slice(0, 3)) {
      expect((await b.post(`/api/v1/media/${id}/complete`)).status).toBe(404);
      expect((await b.delete(`/api/v1/media/${id}`)).status).toBe(404);
    }
    const asReference = await createBatch(b, { products: [{ productGid: defined(bGids[1]) }], commonReferenceMediaIds: [aRef().id] });
    expect(asReference.status).toBe(400);
    const asOutput = await createBatch(b, { products: [{ productGid: defined(bGids[1]), referenceMediaIds: [defined(outputIds[0])] }] });
    expect(asOutput.status).toBe(400);

    // The owner still has everything.
    expect(mediaListResponseSchema.parse((await a.get(`/api/v1/media?ids=${aIds.join(',')}`)).body).items).toHaveLength(7);
    expect(e2e.stub.shop(SHOP_A).files.size).toBe(7);
  });

  it('keeps tokens bound to their store', async () => {
    // A token with the other store's shop domain is refused; a request without a token never reaches data.
    expect((await request(e2e.app).get('/api/v1/batches')).status).toBe(401);
    expect((await request(e2e.app).get(`/api/v1/batches/${bBatch}`).set('authorization', `Bearer ${a.session.accessToken}`)).status).toBe(404);
    expect((await a.get(`/api/v1/batches/${aBatch}`)).status).toBe(200);
  });

  it('keeps product-scoped references private to their upload', async () => {
    const [own] = await uploadReadyReferences(b, [
      { clientId: 'b-product', filename: 'b-product.jpg', mimeType: 'image/jpeg', bytes: FAKE_JPEG, scope: 'product', productGid: defined(bGids[2]) },
      { clientId: 'b-video', filename: 'b-video.mp4', mimeType: 'video/mp4', bytes: FAKE_MP4, scope: 'common', durationSec: 5 },
    ]);
    const res = await createBatch(a, { products: [{ productGid: defined(aGids[2]), referenceMediaIds: [defined(own).id] }] });
    expect(res.status).toBe(400);
    expect(errorOf(res).details).toEqual({ mediaIds: [defined(own).id] });
  });
});

describe('logs', () => {
  it('logged nothing unexpected', () => {
    expect(e2e.problems(['released blocked jobs whose dependencies were already terminal'])).toEqual([]);
  });
});
