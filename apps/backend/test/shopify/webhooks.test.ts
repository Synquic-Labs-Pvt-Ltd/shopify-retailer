import { createHmac } from 'node:crypto';
import express, { type Express } from 'express';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { errorEnvelopeSchema } from '@rs/shared';
import { createErrorHandler, notFoundHandler } from '../../src/core/errors';
import { LoginCodeModel, OAuthStateModel, SessionModel, UserModel } from '../../src/modules/auth/models';
import { ShopModel } from '../../src/modules/shops/model';
import { createShopifyModule, type ShopifyModule } from '../../src/modules/shopify';
import { WEBHOOK_LEASE_MS } from '../../src/modules/shopify/webhooks';
import { WebhookEventModel } from '../../src/modules/shopify/webhook-events';
import { MONGO_START_TIMEOUT_MS, startTestMongo, type TestMongo } from '../helpers/mongo';
import { SHOP, createHarness, createPkce, login, logger, loginForCode, startLogin, type Harness } from '../auth/support';

const OTHER_SHOP = 'other-store.myshopify.com';
let mongo: TestMongo;
let h: Harness;
let shopify: ShopifyModule;
let app: Express;
let counter = 0;

beforeAll(async () => {
  mongo = await startTestMongo('rs_webhooks');
  await Promise.all([ShopModel, UserModel, SessionModel, OAuthStateModel, LoginCodeModel, WebhookEventModel].map((model) => model.init()));
}, MONGO_START_TIMEOUT_MS);

afterAll(async () => {
  await mongo.stop();
});

beforeEach(async () => {
  await mongo.clear();
  h = createHarness();
  shopify = createShopifyModule({ env: h.env, logger, shops: h.shops, auth: h.auth.service, fetchImpl: h.fake.fetchImpl, now: h.clock.now });
  app = express();
  app.use(shopify.webhookRouter);
  // As in the real app: the JSON parser comes after the raw webhook route.
  app.use(express.json());
  app.use(notFoundHandler);
  app.use(createErrorHandler(logger));
});

interface Delivery {
  topic?: string;
  webhookId?: string;
  shop?: string;
  secret?: string;
  body?: string;
  headers?: Record<string, string | undefined>;
}

const sign = (body: string, secret: string): string => createHmac('sha256', secret).update(body).digest('base64');

function deliver(delivery: Delivery = {}): request.Test {
  const body = delivery.body ?? JSON.stringify({ shop_id: 954889, shop_domain: delivery.shop ?? SHOP });
  const headers: Record<string, string | undefined> = {
    'content-type': 'application/json',
    'x-shopify-topic': delivery.topic ?? 'customers/redact',
    'x-shopify-shop-domain': delivery.shop ?? SHOP,
    'x-shopify-webhook-id': delivery.webhookId ?? `wh-${++counter}`,
    'x-shopify-api-version': h.env.SHOPIFY_API_VERSION,
    'x-shopify-hmac-sha256': sign(body, delivery.secret ?? h.env.SHOPIFY_API_SECRET),
    ...delivery.headers,
  };
  let req = request(app).post('/webhooks/shopify');
  for (const [name, value] of Object.entries(headers)) if (value !== undefined) req = req.set(name, value);
  return req.send(body);
}

const errorCode = (res: request.Response): string => errorEnvelopeSchema.parse(res.body).error.code;

describe('HMAC verification', () => {
  it('accepts a correctly signed delivery', async () => {
    expect((await deliver()).status).toBe(200);
  });

  it('verifies the exact raw bytes, whatever the JSON formatting', async () => {
    const body = '{\n  "shop_domain" :  "demo-store.myshopify.com",\n"unicode":"café ✓"  }\n';
    expect((await deliver({ body })).status).toBe(200);
  });

  it('rejects a body that was changed after signing', async () => {
    const signed = JSON.stringify({ shop_domain: SHOP });
    const res = await deliver({ body: `${signed} `, headers: { 'x-shopify-hmac-sha256': sign(signed, h.env.SHOPIFY_API_SECRET) } });
    expect(res.status).toBe(401);
    expect(errorCode(res)).toBe('unauthorized');
  });

  it.each([
    ['another secret', { secret: 'attacker-secret' }],
    ['a missing signature header', { headers: { 'x-shopify-hmac-sha256': undefined } }],
    ['an empty signature', { headers: { 'x-shopify-hmac-sha256': '' } }],
    ['a short signature', { headers: { 'x-shopify-hmac-sha256': 'AAAA' } }],
    ['a hex instead of base64 signature', { headers: { 'x-shopify-hmac-sha256': createHmac('sha256', 'x').update('y').digest('hex') } }],
  ])('rejects %s', async (_label, delivery: Delivery) => {
    const res = await deliver({ webhookId: 'wh-hmac', ...delivery });
    expect(res.status).toBe(401);
    expect(errorCode(res)).toBe('unauthorized');
    expect(await WebhookEventModel.countDocuments()).toBe(0);
  });

  it('rejects missing or invalid headers after the signature check', async () => {
    for (const headers of [
      { 'x-shopify-webhook-id': undefined },
      { 'x-shopify-topic': undefined },
      { 'x-shopify-shop-domain': undefined },
      { 'x-shopify-shop-domain': 'evil.example.com' },
    ]) {
      const res = await deliver({ headers });
      expect(res.status).toBe(400);
      expect(errorCode(res)).toBe('validation_failed');
    }
  });

  it('rejects a signed body that is not JSON', async () => {
    const res = await deliver({ body: 'not json' });
    expect(res.status).toBe(400);
  });

  it('acknowledges but ignores topics the app does not handle', async () => {
    const res = await deliver({ topic: 'products/update' });
    expect(res.status).toBe(200);
    expect(await WebhookEventModel.countDocuments()).toBe(0);
  });
});

describe('idempotency by X-Shopify-Webhook-Id', () => {
  it('processes a webhook id once and answers 200 to repeats', async () => {
    const handler = vi.fn(() => Promise.resolve());
    shopify.service.registerWebhookHandler('customers/redact', handler);

    expect((await deliver({ webhookId: 'wh-same' })).status).toBe(200);
    expect((await deliver({ webhookId: 'wh-same' })).status).toBe(200);
    expect(handler).toHaveBeenCalledTimes(1);

    const event = await WebhookEventModel.findById('wh-same').lean();
    expect(event).toMatchObject({ topic: 'customers/redact', shopDomain: SHOP });
    expect(event?.processedAt).toBeInstanceOf(Date);
    const ttl = (event?.expiresAt.getTime() ?? 0) - (event?.receivedAt.getTime() ?? 0);
    expect(ttl).toBe(7 * 24 * 3_600_000);
  });

  it('processes different webhook ids separately', async () => {
    const handler = vi.fn(() => Promise.resolve());
    shopify.service.registerWebhookHandler('customers/redact', handler);
    await deliver({ webhookId: 'wh-a' });
    await deliver({ webhookId: 'wh-b' });
    expect(handler).toHaveBeenCalledTimes(2);
  });

  it('runs only once when the same delivery arrives concurrently', async () => {
    const handler = vi.fn(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
    });
    shopify.service.registerWebhookHandler('customers/redact', handler);

    const results = await Promise.all(Array.from({ length: 4 }, () => deliver({ webhookId: 'wh-race' })));

    expect(handler).toHaveBeenCalledTimes(1);
    const statuses = results.map((res) => res.status).sort();
    expect(statuses.filter((status) => status === 200).length).toBeGreaterThanOrEqual(1);
    expect(statuses.every((status) => status === 200 || status === 503)).toBe(true);
    // A redelivery after the first attempt settled is a plain duplicate.
    expect((await deliver({ webhookId: 'wh-race' })).status).toBe(200);
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('forgets a failed delivery so the retry is processed again', async () => {
    const handler = vi.fn<() => Promise<void>>().mockRejectedValueOnce(new Error('boom')).mockResolvedValue(undefined);
    shopify.service.registerWebhookHandler('customers/redact', handler);

    const failed = await deliver({ webhookId: 'wh-retry' });
    expect(failed.status).toBe(500);
    expect(errorCode(failed)).toBe('internal');
    expect(await WebhookEventModel.countDocuments()).toBe(0);

    expect((await deliver({ webhookId: 'wh-retry' })).status).toBe(200);
    expect(handler).toHaveBeenCalledTimes(2);
    expect((await WebhookEventModel.findById('wh-retry').lean())?.processedAt).toBeInstanceOf(Date);
  });

  it('answers 503 while another attempt is in flight and takes over once its lease expired', async () => {
    const handler = vi.fn(() => Promise.resolve());
    shopify.service.registerWebhookHandler('customers/redact', handler);
    const receivedAt = h.clock.now();
    await WebhookEventModel.create({ _id: 'wh-stuck', topic: 'customers/redact', shopDomain: SHOP, receivedAt, expiresAt: new Date(receivedAt.getTime() + 1e9) });

    expect((await deliver({ webhookId: 'wh-stuck' })).status).toBe(503);
    expect(handler).not.toHaveBeenCalled();

    h.clock.offsetMs = WEBHOOK_LEASE_MS + 1000;
    expect((await deliver({ webhookId: 'wh-stuck' })).status).toBe(200);
    expect(handler).toHaveBeenCalledTimes(1);
  });
});

describe('compliance topics', () => {
  it.each(['customers/data_request', 'customers/redact'])('%s is acknowledged without touching any data', async (topic) => {
    await login(h);
    const before = await ShopModel.collection.findOne({ shopDomain: SHOP });

    expect((await deliver({ topic })).status).toBe(200);

    expect(await ShopModel.collection.findOne({ shopDomain: SHOP })).toEqual(before);
    expect(await SessionModel.countDocuments({ revokedAt: null })).toBe(1);
  });
});

describe('app/uninstalled', () => {
  it('marks the shop uninstalled, wipes tokens, revokes sessions, then runs the uninstall hooks', async () => {
    const session = await login(h);
    const seen: Array<{ status: string; activeSessions: number; id: string }> = [];
    const hook = vi.fn(async (shop: { id: string; status: string }) => {
      seen.push({ id: shop.id, status: shop.status, activeSessions: await SessionModel.countDocuments({ revokedAt: null }) });
    });
    shopify.service.registerUninstallHook(hook);
    const before = Date.now();

    const res = await deliver({ topic: 'app/uninstalled' });
    expect(res.status).toBe(200);

    const shop = await ShopModel.collection.findOne({ shopDomain: SHOP });
    expect(shop).toMatchObject({ status: 'uninstalled', scopes: [] });
    expect(shop?.offlineToken).toBeUndefined();
    const redactDelay = (shop?.redactAfter as Date).getTime() - before;
    expect(redactDelay).toBeGreaterThanOrEqual(48 * 3_600_000 - 1000);
    expect(redactDelay).toBeLessThan(48 * 3_600_000 + 10_000);

    expect(await SessionModel.countDocuments({ revokedAt: null })).toBe(0);
    const refresh = await request(h.app).post('/api/v1/auth/refresh').send({ refreshToken: session.refreshToken });
    expect(refresh.status).toBe(401);
    expect((await request(h.app).get('/api/v1/me').set('authorization', `Bearer ${session.accessToken}`)).status).toBe(409);

    expect(hook).toHaveBeenCalledTimes(1);
    expect(seen).toEqual([{ id: session.shop.id, status: 'uninstalled', activeSessions: 0 }]);
  });

  it('runs every hook even when one fails, answers 500, and the retry succeeds', async () => {
    await login(h);
    const failing = vi.fn<() => Promise<void>>().mockRejectedValueOnce(new Error('queue down')).mockResolvedValue(undefined);
    const other = vi.fn(() => Promise.resolve());
    shopify.service.registerUninstallHook(failing);
    shopify.service.registerUninstallHook(other);

    expect((await deliver({ topic: 'app/uninstalled', webhookId: 'wh-un' })).status).toBe(500);
    expect(other).toHaveBeenCalledTimes(1);

    expect((await deliver({ topic: 'app/uninstalled', webhookId: 'wh-un' })).status).toBe(200);
    expect(failing).toHaveBeenCalledTimes(2);
    expect(other).toHaveBeenCalledTimes(2);
  });

  it('acknowledges an unknown shop without running hooks', async () => {
    const hook = vi.fn(() => Promise.resolve());
    shopify.service.registerUninstallHook(hook);
    expect((await deliver({ topic: 'app/uninstalled', shop: 'nobody.myshopify.com' })).status).toBe(200);
    expect(hook).not.toHaveBeenCalled();
  });

  it('lets other modules add their own handler for the topic', async () => {
    await login(h);
    const calls: string[] = [];
    shopify.service.registerUninstallHook(() => {
      calls.push('hook');
      return Promise.resolve();
    });
    shopify.service.registerWebhookHandler('app/uninstalled', (context) => {
      calls.push(`handler:${context.shopDomain}:${context.webhookId}`);
      return Promise.resolve();
    });
    await deliver({ topic: 'app/uninstalled', webhookId: 'wh-x' });
    expect(calls).toEqual(['hook', `handler:${SHOP}:wh-x`]);
  });

  it('makes the shop log in through the offline phase again after a reinstall', async () => {
    await login(h);
    await deliver({ topic: 'app/uninstalled' });
    const location = new URL(await startLogin(h, createPkce()));
    expect(location.searchParams.getAll('grant_options[]')).toEqual([]);
    await login(h);
    expect(await h.shops.getByDomain(SHOP)).toMatchObject({ status: 'active' });
  });
});

describe('shop/redact', () => {
  async function seedTwoShops() {
    const mine = await login(h);
    const other = await login(h, {}, OTHER_SHOP);
    await loginForCode(h, createPkce());
    return { mine, other };
  }

  it('runs the redact hooks, then deletes the shop\'s auth data and its document, and only those', async () => {
    const { mine, other } = await seedTwoShops();
    const seen: Array<{ shopId: string; shopDocExists: boolean; users: number }> = [];
    shopify.service.registerRedactHook(async (shopId) => {
      seen.push({ shopId, shopDocExists: (await h.shops.getById(shopId)) !== null, users: await UserModel.countDocuments({ shopId }) });
    });

    expect((await deliver({ topic: 'shop/redact' })).status).toBe(200);

    expect(seen).toEqual([{ shopId: mine.shop.id, shopDocExists: true, users: 1 }]);
    expect(await h.shops.getById(mine.shop.id)).toBeNull();
    expect(await UserModel.countDocuments({ shopId: mine.shop.id })).toBe(0);
    expect(await SessionModel.countDocuments({ shopId: mine.shop.id })).toBe(0);
    expect(await LoginCodeModel.countDocuments({ shopId: mine.shop.id })).toBe(0);
    expect(await OAuthStateModel.countDocuments({ shopDomain: SHOP })).toBe(0);

    expect(await h.shops.getById(other.shop.id)).not.toBeNull();
    expect(await UserModel.countDocuments({ shopId: other.shop.id })).toBe(1);
    expect(await SessionModel.countDocuments({ shopId: other.shop.id })).toBe(1);
  });

  it('purges a shop that was uninstalled 48 hours earlier', async () => {
    await login(h);
    await deliver({ topic: 'app/uninstalled' });
    expect((await deliver({ topic: 'shop/redact' })).status).toBe(200);
    expect(await ShopModel.countDocuments()).toBe(0);
    expect(await UserModel.countDocuments()).toBe(0);
  });

  it('keeps everything when a redact hook fails, so the retry can finish the job', async () => {
    const { mine } = await seedTwoShops();
    const hook = vi.fn<(shopId: string) => Promise<void>>().mockRejectedValueOnce(new Error('media purge failed')).mockResolvedValue(undefined);
    shopify.service.registerRedactHook(hook);

    expect((await deliver({ topic: 'shop/redact', webhookId: 'wh-red' })).status).toBe(500);
    expect(await h.shops.getById(mine.shop.id)).not.toBeNull();
    expect(await UserModel.countDocuments({ shopId: mine.shop.id })).toBe(1);

    expect((await deliver({ topic: 'shop/redact', webhookId: 'wh-red' })).status).toBe(200);
    expect(await h.shops.getById(mine.shop.id)).toBeNull();
    expect(hook).toHaveBeenCalledTimes(2);
  });

  it('acknowledges a shop that is already gone', async () => {
    const hook = vi.fn(() => Promise.resolve());
    shopify.service.registerRedactHook(hook);
    expect((await deliver({ topic: 'shop/redact', shop: 'gone.myshopify.com' })).status).toBe(200);
    expect(hook).not.toHaveBeenCalled();
  });
});
