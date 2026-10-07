import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { batchListResponseSchema, batchSummarySchema, type MediaObject } from '@rs/shared';
import { FAKE_JPEG } from '../../src/modules/ai/fake-media';
import { commonImageSpec, createBatch, defined, errorOf, login, uploadReadyReferences, withNewIp, type ApiClient } from './support/client';
import { MONGO_START_TIMEOUT_MS, startE2e, type E2e } from './support/harness';
import { sleep } from './support/wait';

const SHOP = 'busy-store.myshopify.com';
const OTHER = 'quiet-store.myshopify.com';

let e2e: E2e;
let client: ApiClient;
let quiet: ApiClient;
let reference: MediaObject;

beforeAll(async () => {
  e2e = await startE2e({
    dbName: 'rs_e2e_limits',
    config: (config) => {
      config.batch.maxActiveBatchesPerShop = 100;
    },
  });
  e2e.stub.addShop(SHOP);
  e2e.stub.addShop(OTHER);
  client = await login(e2e, SHOP);
  quiet = await login(e2e, OTHER);
  reference = defined((await uploadReadyReferences(client, [commonImageSpec('common', FAKE_JPEG)]))[0]);
}, MONGO_START_TIMEOUT_MS);

afterAll(async () => {
  await e2e.stop();
});

describe('HTTP behaviour of the whole app', () => {
  it('answers unknown routes and malformed bodies with the error envelope', async () => {
    const missing = await client.get('/api/v1/nothing-here');
    expect(missing.status).toBe(404);
    expect(errorOf(missing).code).toBe('not_found');
    expect(missing.headers['x-request-id']).toBeTruthy();

    const malformed = await request(e2e.app)
      .post('/api/v1/batches')
      .set('authorization', `Bearer ${client.session.accessToken}`)
      .set('content-type', 'application/json')
      .send('{"idempotencyKey":');
    expect(malformed.status).toBe(400);
    expect(errorOf(malformed).code).toBe('validation_failed');

    const huge = await request(e2e.app)
      .post('/api/v1/batches')
      .set('authorization', `Bearer ${client.session.accessToken}`)
      .send({ idempotencyKey: 'x'.repeat(1_100_000) });
    expect(huge.status).toBe(413);
    expect(errorOf(huge).code).toBe('validation_failed');
    // helmet is on and the framework banner is off.
    expect(missing.headers['x-powered-by']).toBeUndefined();
    expect(missing.headers['x-content-type-options']).toBe('nosniff');
  });

  it('pages through batches with cursors, newest first', async () => {
    const ids: string[] = [];
    const products = e2e.stub.shop(SHOP).products;
    for (let index = 0; index < 5; index += 1) {
      const res = await createBatch(client, { products: [{ productGid: defined(products[index]).id }], commonReferenceMediaIds: [reference.id] });
      expect(res.status).toBe(201);
      ids.unshift(batchSummarySchema.parse(res.body).id);
    }
    const seen: string[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < 6; page += 1) {
      const res: request.Response = await client.get(`/api/v1/batches?limit=2${cursor === null ? '' : `&cursor=${cursor}`}`);
      const body = batchListResponseSchema.parse(res.body);
      expect(body.items.length).toBeLessThanOrEqual(2);
      seen.push(...body.items.map((item) => item.id));
      if (!body.pageInfo.hasNextPage) break;
      cursor = body.pageInfo.endCursor;
    }
    expect(seen).toEqual(ids);
    expect((await client.get('/api/v1/batches?cursor=garbage')).status).toBe(400);
    expect((await client.get('/api/v1/batches?limit=0')).status).toBe(400);
    expect((await client.get('/api/v1/batches?limit=51')).status).toBe(400);
  });
});

describe('Shopify Admin API failures', () => {
  it('waits out THROTTLED answers and gives up after three retries', async () => {
    e2e.stub.state.knobs.throttle = { operation: 'ProductList', remaining: 2 };
    const started = Date.now();
    expect((await client.get('/api/v1/products?limit=1')).status).toBe(200);
    // (50 - 10) / 100 restore rate = 0.4 s per throttled answer.
    expect(Date.now() - started).toBeGreaterThanOrEqual(700);
    expect(e2e.stub.graphqlOperations(SHOP).filter((operation) => operation === 'ProductList')).toHaveLength(3);

    e2e.stub.state.knobs.throttle = { operation: 'ProductList', remaining: 10 };
    const exhausted = await client.get('/api/v1/products?limit=1');
    expect(exhausted.status).toBe(429);
    expect(errorOf(exhausted).code).toBe('too_many_requests');
    e2e.stub.state.knobs.throttle = null;
  });

  it('maps a Shopify outage to a 502 envelope without leaking the upstream body', async () => {
    e2e.stub.state.knobs.httpFailure = { operation: 'ProductList', status: 503, remaining: 1 };
    const res = await client.get('/api/v1/products?limit=1');
    expect(res.status).toBe(502);
    expect(errorOf(res)).toMatchObject({ code: 'internal', details: { upstream: 'shopify', status: 503 } });
    expect(JSON.stringify(res.body)).not.toContain('failing on purpose');
    expect((await client.get('/api/v1/products?limit=1')).status).toBe(200);
  });

  it('sends the app back to login when Shopify revoked the token', async () => {
    e2e.stub.revokeTokens(SHOP);
    const res = await client.get('/api/v1/products?limit=1');
    expect(res.status).toBe(409);
    expect(errorOf(res).code).toBe('shop_reauth_required');
    expect((await client.get('/api/v1/batches')).status).toBe(409);
    client = await login(e2e, SHOP);
    expect((await client.get('/api/v1/products?limit=1')).status).toBe(200);
  });

  it('survives a failing shop query when installing a store', async () => {
    e2e.stub.addShop('third-store.myshopify.com');
    e2e.stub.state.knobs.failShopQuery = true;
    const third = await login(e2e, 'third-store.myshopify.com');
    e2e.stub.state.knobs.failShopQuery = false;
    // The name falls back to the domain until Shopify answers.
    expect(third.session.shop.name).toBe('third-store.myshopify.com');
    expect((await third.get('/api/v1/products?limit=1')).status).toBe(200);
  });
});

describe('per-user rate limit (SPEC 18)', () => {
  it('allows 300 API requests a minute per user, /me included, and counts each user on their own', async () => {
    // A fresh session starts with an empty budget. Access tokens carry no random id, so wait for a new second.
    await sleep(1100);
    const token = (await login(e2e, SHOP)).session.accessToken;
    const statuses = new Set<number>();
    for (let count = 0; count < 300; count += 1) {
      statuses.add((await request(e2e.app).get('/api/v1/me').set('authorization', `Bearer ${token}`)).status);
    }
    expect([...statuses]).toEqual([200]);

    const limited = await request(e2e.app).get('/api/v1/me').set('authorization', `Bearer ${token}`);
    expect(limited.status).toBe(429);
    expect(errorOf(limited).code).toBe('too_many_requests');
    expect((await request(e2e.app).get('/api/v1/products').set('authorization', `Bearer ${token}`)).status).toBe(429);

    // Another user is not affected.
    expect((await quiet.get('/api/v1/products?limit=1')).status).toBe(200);
    expect((await withNewIp(request(e2e.app).get('/health'))).status).toBe(200);
  });
});
