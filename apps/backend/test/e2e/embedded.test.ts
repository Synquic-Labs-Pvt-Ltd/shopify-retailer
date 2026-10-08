import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { meResponseSchema, productListResponseSchema, type MediaObject, type ProductListItem } from '@rs/shared';
import { FAKE_JPEG } from '../../src/modules/ai/fake-media';
import { LoginCodeModel, OAuthStateModel, SessionModel, UserModel } from '../../src/modules/auth/models';
import { BatchModel } from '../../src/modules/batches/models';
import { ShopModel } from '../../src/modules/shops/model';
import { DEFAULT_SHOPIFY_USER_ID } from '../helpers/session-token';
import { commonImageSpec, createBatch, defined, errorOf, getBatch, login, sendWebhook, uploadReadyReferences } from './support/client';
import { embeddedClient, type EmbeddedClient } from './support/embedded';
import { MONGO_START_TIMEOUT_MS, startE2e, type E2e } from './support/harness';

// The embedded Shopify app (apps/web) talks to the backend with App Bridge session tokens only: no login flow, no
// refresh token. This is the whole journey of a merchant who opens the app for the first time, through the real app,
// container and queue on an in-memory MongoDB, with Shopify stubbed at the global fetch.

const SHOP = 'embedded-store.myshopify.com';

let e2e: E2e;
let client: EmbeddedClient;
let products: ProductListItem[] = [];
let reference: MediaObject;
let batchId = '';
let shopId = '';

beforeAll(async () => {
  e2e = await startE2e({ dbName: 'rs_e2e_embedded' });
  e2e.stub.addShop(SHOP);
  client = embeddedClient(e2e, SHOP);
}, MONGO_START_TIMEOUT_MS);

afterAll(async () => {
  await e2e.stop();
});

const tokenCalls = () => e2e.stub.state.calls.filter((call) => call.kind === 'token');
const rawShop = () => ShopModel.findOne({ shopDomain: SHOP }).lean();

describe('first open of the app inside the Shopify admin', () => {
  it('authorizes the shop with one token exchange, however many requests arrive at once', async () => {
    expect(await ShopModel.countDocuments()).toBe(0);
    e2e.stub.state.knobs.exchangeDelayMs = 100;
    const responses = await Promise.all(Array.from({ length: 6 }, () => client.get('/api/v1/me')));
    e2e.stub.state.knobs.exchangeDelayMs = 0;

    expect(responses.map((res) => res.status)).toEqual(Array(6).fill(200));
    expect(tokenCalls().map((call) => ({ grant: call.grant, expiring: call.expiring, status: call.status }))).toEqual([
      { grant: 'token_exchange', expiring: true, status: 200 },
    ]);

    const me = meResponseSchema.parse(responses[0]?.body);
    expect(me.shop).toMatchObject({ domain: SHOP, name: e2e.stub.shop(SHOP).info.name });
    expect(me.user).toMatchObject({ email: null, firstName: null, lastName: null });
    expect(me.generation.imagesPerProduct).toBe(2);
    shopId = me.shop.id;

    const shop = defined(await rawShop());
    expect(shop).toMatchObject({ status: 'active', shopGid: e2e.stub.shop(SHOP).info.id, currencyCode: 'INR', ianaTimezone: 'Asia/Kolkata' });
    expect([...shop.scopes].sort()).toEqual(['read_files', 'read_products', 'write_files']);
    expect(JSON.stringify(shop)).not.toMatch(/shp(at|rt)_/);
    expect(shop.offlineToken?.accessTokenEnc?.split(':')).toHaveLength(3);
    expect(shop.offlineToken?.refreshTokenEnc?.split(':')).toHaveLength(3);
    expect(await UserModel.countDocuments({ shopId: shop._id })).toBe(1);
  });

  it('never ran the login flow: no oauth state, login code or session exists', async () => {
    expect(await OAuthStateModel.countDocuments()).toBe(0);
    expect(await LoginCodeModel.countDocuments()).toBe(0);
    expect(await SessionModel.countDocuments()).toBe(0);
    // Not even the cheap routes of the login flow were needed.
    expect(tokenCalls().some((call) => call.grant === 'authorization_code')).toBe(false);
  });

  it('refuses the same requests with bad session tokens, without calling Shopify', async () => {
    const before = e2e.stub.state.calls.length;
    const bad = [
      client.token({ at: Date.now() - 180_000 }),
      client.token({ secret: 'not-the-client-secret-not-the-client-secret' }),
      client.token({ claims: { aud: 'some-other-app' } }),
      client.token({ alg: 'none' }),
      client.token({ claims: { iss: 'https://another-store.myshopify.com/admin' } }),
    ];
    for (const token of bad) {
      const res = await request(e2e.app).get('/api/v1/me').set('authorization', `Bearer ${token}`);
      expect(res.status).toBe(401);
      expect(errorOf(res).code).toBe('unauthorized');
    }
    expect((await request(e2e.app).get('/api/v1/me')).status).toBe(401);
    expect(e2e.stub.state.calls.length).toBe(before);
  });
});

describe('working in the embedded app', () => {
  it('lists the products with the stored offline token', async () => {
    const res = await client.get('/api/v1/products?limit=3');
    expect(res.status).toBe(200);
    const body = productListResponseSchema.parse(res.body);
    expect(body.items).toHaveLength(3);
    expect(body.pageInfo.hasNextPage).toBe(true);
    products = body.items;

    const shop = e2e.stub.shop(SHOP);
    const tokens = e2e.stub.state.calls.flatMap((call) => (call.kind === 'graphql' ? [call.token] : []));
    expect(tokens.length).toBeGreaterThan(0);
    expect(tokens.every((token) => token !== undefined && shop.offlineTokens.has(token))).toBe(true);
  });

  it('uploads a reference, creates a batch with the fake provider and sees it complete', async () => {
    reference = defined((await uploadReadyReferences(client, [commonImageSpec('embedded-common', FAKE_JPEG)]))[0]);
    const productGid = defined(products[0]).id;

    const created = await createBatch(client, { products: [{ productGid }], commonReferenceMediaIds: [reference.id] });
    expect(created.status).toBe(201);
    batchId = (created.body as { id: string }).id;

    const batch = await e2e.driveBatch(batchId, { timeoutMs: 60_000 });
    expect(batch.status).toBe('completed');
    await e2e.settle();

    const detail = await getBatch(client, batchId);
    expect(detail).toMatchObject({ status: 'completed', counts: { products: 1, jobsSucceeded: 4, jobsFailed: 0, imagesReady: 2, videosReady: 1 } });
    expect(detail.items[0]?.outputs.map((output) => output.mediaType)).toEqual(['image', 'image', 'video']);
    expect((await client.get('/api/v1/batches')).status).toBe(200);
  }, 90_000);

  it('used exactly one token exchange for the whole journey and no refresh', () => {
    expect(tokenCalls().map((call) => call.grant)).toEqual(['token_exchange']);
    expect(e2e.stub.state.unexpected).toEqual([]);
  });

  it('keeps staff members apart: a second staff user has their own record and cannot see the first one\'s media or batches', async () => {
    const colleague = embeddedClient(e2e, SHOP, 424242);
    const me = meResponseSchema.parse((await colleague.get('/api/v1/me')).body);
    expect(me.shop.id).toBe(shopId);
    expect(await UserModel.countDocuments({ shopId })).toBe(2);
    // Tenant isolation is by shop, so the colleague works on the same shop data.
    expect((await colleague.get(`/api/v1/batches/${batchId}`)).status).toBe(200);
    expect(tokenCalls()).toHaveLength(1);

    // A staff member of another shop cannot reach this shop's data by naming it in the URL or the body.
    e2e.stub.addShop('other-embedded.myshopify.com');
    const stranger = embeddedClient(e2e, 'other-embedded.myshopify.com');
    expect((await stranger.get('/api/v1/me')).status).toBe(200);
    expect((await stranger.get(`/api/v1/batches/${batchId}`)).status).toBe(404);
    expect(errorOf(await stranger.get(`/api/v1/batches/${batchId}`)).code).toBe('not_found');
    expect(meResponseSchema.parse((await stranger.get('/api/v1/me')).body).shop.id).not.toBe(shopId);
  });
});

describe('uninstalling and reinstalling', () => {
  it('revokes access after the uninstall webhook: the app is gone on Shopify, so the exchange is refused', async () => {
    e2e.stub.uninstallApp(SHOP);
    const hook = await sendWebhook(e2e, { topic: 'app/uninstalled', shop: SHOP });
    expect(hook.status).toBe(200);
    expect(await rawShop()).toMatchObject({ status: 'uninstalled' });
    expect((await rawShop())?.offlineToken?.accessTokenEnc).toBeUndefined();

    const before = tokenCalls().length;
    for (const path of ['/api/v1/me', '/api/v1/products', '/api/v1/batches']) {
      const res = await client.get(path);
      expect(res.status).toBe(409);
      expect(errorOf(res).code).toBe('shop_reauth_required');
    }
    // Every request tried the exchange once (a reinstall would make it work) and Shopify said no.
    expect(tokenCalls().slice(before).map((call) => [call.grant, call.status])).toEqual(Array(3).fill(['token_exchange', 400]));
    expect(await rawShop()).toMatchObject({ status: 'uninstalled' });
    expect((await rawShop())?.offlineToken?.accessTokenEnc).toBeUndefined();
    // The other shop is not affected.
    expect((await embeddedClient(e2e, 'other-embedded.myshopify.com').get('/api/v1/me')).status).toBe(200);
  });

  it('works again when the merchant reinstalls: same shop, same users, same batches', async () => {
    e2e.stub.reinstallApp(SHOP);
    const res = await client.get('/api/v1/me');
    expect(res.status).toBe(200);
    expect(meResponseSchema.parse(res.body).shop.id).toBe(shopId);
    expect(await rawShop()).toMatchObject({ status: 'active' });
    expect((await rawShop())?.redactAfter).toBeUndefined();
    expect(await UserModel.countDocuments({ shopId })).toBe(2);
    expect((await BatchModel.findById(batchId).lean())?.status).toBe('completed');
    expect((await client.get('/api/v1/products?limit=1')).status).toBe(200);
    expect((await client.get(`/api/v1/batches/${batchId}`)).status).toBe(200);
  });
});

describe('the phone and the embedded app side by side', () => {
  it('maps the same Shopify user to the same record and fills in the profile the phone login knows', async () => {
    const before = meResponseSchema.parse((await client.get('/api/v1/me')).body);
    expect(before.user.email).toBeNull();

    const mobile = await login(e2e, SHOP, { user: { id: DEFAULT_SHOPIFY_USER_ID } });
    expect(mobile.session.user.id).toBe(before.user.id);
    const mobileMe = meResponseSchema.parse((await mobile.get('/api/v1/me')).body);
    expect(mobileMe.user).toMatchObject({ id: before.user.id, email: 'asha@example.com', firstName: 'Asha' });

    // The embedded app now shows the same profile, and both keep working.
    const after = meResponseSchema.parse((await client.get('/api/v1/me')).body);
    expect(after.user).toEqual(mobileMe.user);
    expect((await mobile.get('/api/v1/products?limit=1')).status).toBe(200);
    expect((await client.get('/api/v1/products?limit=1')).status).toBe(200);
  });

  it('logged nothing unexpected', () => {
    // The refused exchanges after the uninstall are expected; the orphan sweep may win a harmless race with a handler.
    expect(e2e.problems(['Shopify refused the session token exchange', 'released blocked jobs whose dependencies were already terminal'])).toEqual([]);
  });
});
