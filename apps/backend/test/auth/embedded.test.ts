import express from 'express';
import type { Request } from 'express';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { defaultGenerationConfig, errorEnvelopeSchema, meResponseSchema } from '@rs/shared';
import { createApiLimiter } from '../../src/core/api-limiter';
import { createErrorHandler } from '../../src/core/errors';
import { createAuthModule } from '../../src/modules/auth';
import { LAST_SEEN_INTERVAL_MS } from '../../src/modules/auth/embedded';
import { LoginCodeModel, OAuthStateModel, SessionModel, UserModel } from '../../src/modules/auth/models';
import { createShopsModule } from '../../src/modules/shops';
import { ShopModel } from '../../src/modules/shops/model';
import { MONGO_START_TIMEOUT_MS, startTestMongo, type TestMongo } from '../helpers/mongo';
import { DEFAULT_SHOPIFY_USER_ID } from '../helpers/session-token';
import { DEFAULT_USER } from '../shopify/fake-shopify';
import { SHOP, createHarness, login, logger, sessionToken, type Harness } from './support';

// Embedded app: App Bridge session tokens as bearer tokens, through the real auth module and an in-memory MongoDB.

let mongo: TestMongo;
let h: Harness;

beforeAll(async () => {
  mongo = await startTestMongo('rs_auth_embedded');
  await Promise.all([ShopModel, UserModel, SessionModel, OAuthStateModel, LoginCodeModel].map((model) => model.init()));
}, MONGO_START_TIMEOUT_MS);

afterAll(async () => {
  await mongo.stop();
});

beforeEach(async () => {
  await mongo.clear();
  h = createHarness();
});

const me = (token: string): request.Test => request(h.app).get('/api/v1/me').set('authorization', `Bearer ${token}`);
const errorOf = (res: request.Response) => errorEnvelopeSchema.parse(res.body).error;
const exchangeCount = (): number => h.fake.exchangeCalls().length;
const rawShop = () => ShopModel.collection.findOne({ shopDomain: SHOP });
const asRequest = (authorization?: string): Request =>
  ({ header: (name: string) => (name.toLowerCase() === 'authorization' ? authorization : undefined) }) as unknown as Request;

describe('our own access JWT keeps working exactly as before', () => {
  it('authenticates the mobile session without touching the session token path', async () => {
    const session = await login(h);
    const res = await me(session.accessToken);
    expect(res.status).toBe(200);
    const body = meResponseSchema.parse(res.body);
    expect(body.user).toEqual({ id: session.user.id, email: DEFAULT_USER.email, firstName: 'Asha', lastName: 'Verma' });
    expect(exchangeCount()).toBe(0);
    await expect(h.auth.service.verifyAccessToken(session.accessToken)).resolves.toEqual({
      userId: session.user.id,
      shopId: session.shop.id,
      shopDomain: SHOP,
    });
  });

  it('answers the same 401 for tokens that are neither ours nor Shopify session tokens', async () => {
    const session = await login(h);
    for (const token of ['garbage', `${session.accessToken}x`, 'a.b.c', 'x'.repeat(60)]) {
      const res = await me(token);
      expect(res.status).toBe(401);
      expect(errorOf(res)).toMatchObject({ code: 'unauthorized', message: 'Invalid or expired access token' });
    }
    expect((await request(h.app).get('/api/v1/me')).status).toBe(401);
    expect((await request(h.app).get('/api/v1/me').set('authorization', `Basic ${session.accessToken}`)).status).toBe(401);
    h.clock.offsetMs = 15 * 60_000 + 1000;
    expect((await me(session.accessToken)).status).toBe(401);
    expect(exchangeCount()).toBe(0);
  });

  it('still answers 409 for an uninstalled shop and does not try an exchange for an access JWT', async () => {
    const session = await login(h);
    await h.shops.markUninstalled(SHOP);
    const res = await me(session.accessToken);
    expect(res.status).toBe(409);
    expect(errorOf(res).code).toBe('shop_reauth_required');
    expect(exchangeCount()).toBe(0);
  });
});

describe('a session token for a shop that is already known', () => {
  it('authenticates without an exchange and maps the staff user to the user of the mobile login', async () => {
    const session = await login(h);
    expect(await UserModel.countDocuments()).toBe(1);

    const res = await me(await sessionToken(h, { sub: DEFAULT_SHOPIFY_USER_ID }));
    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    const body = meResponseSchema.parse(res.body);
    // Same Shopify user id, same document, profile untouched.
    expect(body.user).toEqual({ id: session.user.id, email: DEFAULT_USER.email, firstName: 'Asha', lastName: 'Verma' });
    expect(body.shop).toEqual({ id: session.shop.id, domain: SHOP, name: 'Demo Store' });
    expect(exchangeCount()).toBe(0);
    expect(await UserModel.countDocuments()).toBe(1);
    expect(await UserModel.findById(session.user.id).lean()).toMatchObject({ email: DEFAULT_USER.email, firstName: 'Asha', accountOwner: true });
  });

  it('creates the staff user once, with no email or names, and /me validates against the shared schema', async () => {
    await login(h);
    const statuses: number[] = [];
    let id = '';
    for (let i = 0; i < 4; i += 1) {
      const res = await me(await sessionToken(h, { sub: 4242 }));
      statuses.push(res.status);
      const body = meResponseSchema.parse(res.body);
      expect(body.user).toMatchObject({ email: null, firstName: null, lastName: null });
      if (i === 0) id = body.user.id;
      expect(body.user.id).toBe(id);
    }
    expect(statuses).toEqual([200, 200, 200, 200]);
    expect(await UserModel.countDocuments({ shopifyUserId: '4242' })).toBe(1);
    const user = await UserModel.findById(id).lean();
    expect(user).toMatchObject({ shopifyUserId: '4242' });
    expect(String(user?.shopId)).toBe((await h.shops.getByDomain(SHOP))?.id);
    expect(user?.lastLoginAt).toBeInstanceOf(Date);
    expect(user?.email).toBeUndefined();
    expect(exchangeCount()).toBe(0);
  });

  it('writes lastLoginAt at most once per interval', async () => {
    await login(h);
    const start = h.clock.now().getTime();
    await me(await sessionToken(h, { sub: 77 }));
    const first = await UserModel.findOne({ shopifyUserId: '77' }).lean();
    expect(first?.lastLoginAt?.getTime()).toBeGreaterThanOrEqual(start);
    expect(first?.lastLoginAt?.getTime()).toBeLessThanOrEqual(Date.now());

    // Inside the interval nothing is written, not even updatedAt.
    h.clock.offsetMs = LAST_SEEN_INTERVAL_MS - 1000;
    await me(await sessionToken(h, { sub: 77 }));
    const quiet = await UserModel.findOne({ shopifyUserId: '77' }).lean();
    expect(quiet?.lastLoginAt).toEqual(first?.lastLoginAt);
    expect(quiet?.updatedAt).toEqual(first?.updatedAt);

    // After the interval it is refreshed once.
    h.clock.offsetMs = LAST_SEEN_INTERVAL_MS + 1000;
    await me(await sessionToken(h, { sub: 77 }));
    const later = await UserModel.findOne({ shopifyUserId: '77' }).lean();
    expect(later?.lastLoginAt?.getTime()).toBeGreaterThan((first?.lastLoginAt?.getTime() ?? 0) + LAST_SEEN_INTERVAL_MS);
    expect(later?._id).toEqual(first?._id);
  });

  it('keeps users of different staff members and different shops apart', async () => {
    await login(h);
    await login(h, {}, 'other-store.myshopify.com');
    const a = meResponseSchema.parse((await me(await sessionToken(h, { sub: 1 }))).body);
    const b = meResponseSchema.parse((await me(await sessionToken(h, { sub: 2 }))).body);
    const other = meResponseSchema.parse((await me(await sessionToken(h, { sub: 1, shop: 'other-store.myshopify.com' }))).body);
    expect(new Set([a.user.id, b.user.id, other.user.id]).size).toBe(3);
    expect(other.shop.domain).toBe('other-store.myshopify.com');
    expect(a.shop.id).toBe(b.shop.id);
    expect(other.shop.id).not.toBe(a.shop.id);
  });

  it('creates one user for 12 concurrent first requests of the same staff member', async () => {
    await login(h);
    const tokens = await Promise.all(Array.from({ length: 12 }, () => sessionToken(h, { sub: 9001 })));
    const responses = await Promise.all(tokens.map((token) => me(token)));
    expect(responses.map((res) => res.status)).toEqual(Array(12).fill(200));
    expect(new Set(responses.map((res) => meResponseSchema.parse(res.body).user.id)).size).toBe(1);
    expect(await UserModel.countDocuments({ shopifyUserId: '9001' })).toBe(1);
  });

  it('rejects a token with a bad signature, a stale clock, the wrong app, or a mismatched shop with a 401 and no side effect', async () => {
    await login(h);
    const users = await UserModel.countDocuments();
    const bad = [
      await sessionToken(h, { secret: 'attacker-secret-attacker-secret-1234' }),
      await sessionToken(h, { alg: 'none' }),
      await sessionToken(h, { alg: 'HS384' }),
      await sessionToken(h, { at: h.clock.now().getTime() - 120_000 }),
      await sessionToken(h, { claims: { aud: 'another-app' } }),
      await sessionToken(h, { claims: { iss: 'https://other.myshopify.com/admin' } }),
      await sessionToken(h, { claims: { dest: 'https://evil.example.com', iss: 'https://evil.example.com/admin' } }),
      await sessionToken(h, { omit: ['sub'] }),
    ];
    for (const token of bad) {
      const res = await me(token);
      expect(res.status).toBe(401);
      expect(errorOf(res)).toMatchObject({ code: 'unauthorized', message: 'Invalid or expired session token' });
    }
    expect(exchangeCount()).toBe(0);
    expect(await UserModel.countDocuments()).toBe(users);
    expect(await ShopModel.countDocuments()).toBe(1);
  });

  it('does not accept a session token of another app that happens to name this shop', async () => {
    const res = await me(await sessionToken(h, { claims: { aud: `${h.env.SHOPIFY_API_KEY}-other` } }));
    expect(res.status).toBe(401);
    expect(await ShopModel.countDocuments()).toBe(0);
    expect(h.fake.calls).toHaveLength(0);
  });
});

describe('a session token for a shop we have never seen', () => {
  it('exchanges it, activates the shop with encrypted tokens and stores the shop info', async () => {
    const token = await sessionToken(h, { sub: 31337 });
    const res = await me(token);
    expect(res.status).toBe(200);
    const body = meResponseSchema.parse(res.body);
    expect(body.shop).toMatchObject({ domain: SHOP, name: 'Demo Store' });
    expect(body.user).toMatchObject({ email: null, firstName: null, lastName: null });

    expect(exchangeCount()).toBe(1);
    expect(h.fake.exchangeCalls()[0]?.form).toMatchObject({ subject_token: token, expiring: '1' });
    const raw = await rawShop();
    expect(raw).toMatchObject({ status: 'active', name: 'Demo Store', shopGid: 'gid://shopify/Shop/1001', currencyCode: 'INR' });
    expect(JSON.stringify(raw)).not.toMatch(/shp(at|rt)_/);
    expect((raw?.offlineToken as { accessTokenEnc: string }).accessTokenEnc.split(':')).toHaveLength(3);
    expect(await UserModel.countDocuments()).toBe(1);

    // The stored token is good for Admin API calls and there is no second exchange.
    await expect(h.shops.getAccessToken(body.shop.id)).resolves.toMatch(/^shpat_offline_/);
    expect((await me(await sessionToken(h, { sub: 31337 }))).status).toBe(200);
    expect(exchangeCount()).toBe(1);
  });

  it('sends exactly one exchange for 12 concurrent first requests, each with its own token', async () => {
    h.fake.exchange.delayMs = 120;
    const tokens = await Promise.all(Array.from({ length: 12 }, (_, i) => sessionToken(h, { sub: 500 + (i % 3) })));
    const responses = await Promise.all(tokens.map((token) => me(token)));

    expect(responses.map((res) => res.status)).toEqual(Array(12).fill(200));
    expect(exchangeCount()).toBe(1);
    expect(await ShopModel.countDocuments()).toBe(1);
    expect(await UserModel.countDocuments()).toBe(3);
    expect(new Set(responses.map((res) => meResponseSchema.parse(res.body).shop.id)).size).toBe(1);
  });

  it('sends exactly one exchange when two backend instances sharing the database get the first requests', async () => {
    h.fake.exchange.delayMs = 120;
    const shops = createShopsModule({ env: h.env, logger, fetchImpl: h.fake.fetchImpl, now: h.clock.now, lockPollMs: 10 }).service;
    const auth = createAuthModule({
      env: h.env,
      logger,
      shops,
      fetchImpl: h.fake.fetchImpl,
      now: h.clock.now,
      getGenerationConfig: () => defaultGenerationConfig,
    });
    const second = express();
    second.use(express.json());
    second.use('/api/v1', auth.apiRouter);
    second.use(createErrorHandler(logger));

    const tokens = await Promise.all(Array.from({ length: 8 }, () => sessionToken(h, { sub: 5 })));
    const responses = await Promise.all(
      tokens.map((token, i) => request(i % 2 === 0 ? h.app : second).get('/api/v1/me').set('authorization', `Bearer ${token}`)),
    );

    expect(responses.map((res) => res.status)).toEqual(Array(8).fill(200));
    expect(exchangeCount()).toBe(1);
    expect(await ShopModel.countDocuments()).toBe(1);
    expect(await UserModel.countDocuments()).toBe(1);
  });

  it('answers 409 when Shopify refuses the exchange and activates nothing', async () => {
    h.fake.exchange.refuse.add(SHOP);
    const res = await me(await sessionToken(h));
    expect(res.status).toBe(409);
    expect(errorOf(res).code).toBe('shop_reauth_required');
    expect(exchangeCount()).toBe(1);
    expect(await ShopModel.countDocuments()).toBe(0);
    expect(await UserModel.countDocuments()).toBe(0);

    // A later request after the app was installed works.
    h.fake.exchange.refuse.clear();
    expect((await me(await sessionToken(h))).status).toBe(200);
    expect((await rawShop())?.status).toBe('active');
  });

  it('answers 502 when Shopify is down and keeps the next request able to succeed', async () => {
    h.fake.exchange.forceStatus = 503;
    const res = await me(await sessionToken(h));
    expect(res.status).toBe(502);
    expect(errorOf(res)).toMatchObject({ code: 'internal', details: { upstream: 'shopify' } });
    expect(await ShopModel.countDocuments()).toBe(0);

    h.fake.exchange.forceStatus = null;
    expect((await me(await sessionToken(h))).status).toBe(200);
  });

  it('never calls Shopify for a token it can reject locally', async () => {
    for (const token of [await sessionToken(h, { secret: 'wrong-secret-wrong-secret-wrong-secret' }), await sessionToken(h, { at: Date.now() - 600_000 })]) {
      expect((await me(token)).status).toBe(401);
    }
    expect(h.fake.calls).toHaveLength(0);
  });
});

describe('a shop that was uninstalled and comes back', () => {
  it('tries the exchange once and refuses with 409 while the app is not installed', async () => {
    const session = await login(h);
    await h.shops.markUninstalled(SHOP);
    h.fake.exchange.refuse.add(SHOP);

    const res = await me(await sessionToken(h, { sub: DEFAULT_SHOPIFY_USER_ID }));
    expect(res.status).toBe(409);
    expect(errorOf(res).code).toBe('shop_reauth_required');
    expect(exchangeCount()).toBe(1);
    expect(await rawShop()).toMatchObject({ status: 'uninstalled' });
    expect((await rawShop())?.offlineToken?.accessTokenEnc).toBeUndefined();
    expect((await me(session.accessToken)).status).toBe(409);
  });

  it('reactivates the shop, keeps its id and its users when the merchant reinstalls', async () => {
    const session = await login(h);
    await h.shops.markUninstalled(SHOP);

    const res = await me(await sessionToken(h, { sub: DEFAULT_SHOPIFY_USER_ID }));
    expect(res.status).toBe(200);
    expect(exchangeCount()).toBe(1);
    const body = meResponseSchema.parse(res.body);
    expect(body.shop.id).toBe(session.shop.id);
    expect(body.user.id).toBe(session.user.id);
    const raw = await rawShop();
    expect(raw?.status).toBe('active');
    expect(raw?.redactAfter).toBeUndefined();
    expect(raw?.uninstalledAt).toBeUndefined();
    expect(await h.shops.getAccessToken(session.shop.id)).toMatch(/^shpat_offline_/);
  });

  it('also heals a shop that needed a new login', async () => {
    const session = await login(h);
    await h.shops.markReauthRequired(session.shop.id);
    expect((await me(session.accessToken)).status).toBe(409);
    expect((await me(await sessionToken(h, { sub: DEFAULT_SHOPIFY_USER_ID }))).status).toBe(200);
    // The mobile session works again too, because the shop is active.
    expect((await me(session.accessToken)).status).toBe(200);
  });
});

describe('per-user rate limit keys', () => {
  const pingApp = (limit: number): express.Express => {
    const app = express();
    app.set('trust proxy', 1);
    app.use(createApiLimiter(h.auth.service.rateLimitKey, limit));
    app.get('/ping', (_req, res) => {
      res.json({ ok: true });
    });
    app.use(createErrorHandler(logger));
    return app;
  };
  const ping = (app: express.Express, token: string, ip?: string): request.Test => {
    const call = request(app).get('/ping').set('authorization', `Bearer ${token}`);
    return ip === undefined ? call : call.set('x-forwarded-for', ip);
  };

  it('puts every session token of one staff member into one bucket', async () => {
    const app = pingApp(3);
    for (let i = 0; i < 3; i += 1) expect((await ping(app, await sessionToken(h, { sub: 10 }))).status).toBe(200);
    const limited = await ping(app, await sessionToken(h, { sub: 10 }));
    expect(limited.status).toBe(429);
    expect(errorOf(limited).code).toBe('too_many_requests');

    // Another staff member of the same shop, and the same id in another shop, have their own budgets.
    expect((await ping(app, await sessionToken(h, { sub: 11 }))).status).toBe(200);
    expect((await ping(app, await sessionToken(h, { sub: 10, shop: 'other-store.myshopify.com' }))).status).toBe(200);
  });

  it('keys a mobile access token on shop and user, so a new login does not reset the budget', async () => {
    const app = pingApp(2);
    const first = await login(h);
    expect((await ping(app, first.accessToken)).status).toBe(200);
    expect((await ping(app, first.accessToken)).status).toBe(200);
    expect((await ping(app, first.accessToken)).status).toBe(429);

    h.clock.offsetMs = 2000;
    const second = await login(h);
    expect(second.accessToken).not.toBe(first.accessToken);
    expect((await ping(app, second.accessToken)).status).toBe(429);

    // Another user of the same shop is not affected.
    const other = await login(h, { user: { id: 123456 } });
    expect((await ping(app, other.accessToken)).status).toBe(200);
  });

  it('does not let an unsigned token spend somebody else\'s budget: it falls back to the client IP', async () => {
    const app = pingApp(2);
    const victim = (): Promise<string> => sessionToken(h, { sub: 10 });
    const forged = [
      () => sessionToken(h, { sub: 10, alg: 'none' }),
      () => sessionToken(h, { sub: 10, secret: 'attacker-secret-attacker-secret-1234' }),
      () => sessionToken(h, { sub: 10, alg: 'HS384' }),
    ];
    // The attacker burns its own IP budget with tokens that claim to be the victim.
    expect((await ping(app, await (forged[0]?.() ?? ''), '198.51.100.9')).status).toBe(200);
    expect((await ping(app, await (forged[1]?.() ?? ''), '198.51.100.9')).status).toBe(200);
    expect((await ping(app, await (forged[2]?.() ?? ''), '198.51.100.9')).status).toBe(429);

    // The victim has all of theirs.
    expect((await ping(app, await victim(), '198.51.100.10')).status).toBe(200);
    expect((await ping(app, await victim(), '198.51.100.10')).status).toBe(200);
    expect((await ping(app, await victim(), '198.51.100.10')).status).toBe(429);
  });

  it('resolves keys from signatures alone: no exchange, no database writes', async () => {
    const key = (token?: string) => h.auth.service.rateLimitKey(asRequest(token === undefined ? undefined : `Bearer ${token}`));

    await expect(key(await sessionToken(h, { sub: 77 }))).resolves.toBe(`shop:${SHOP}:77`);
    expect(h.fake.calls).toHaveLength(0);
    expect(await ShopModel.countDocuments()).toBe(0);
    expect(await UserModel.countDocuments()).toBe(0);

    const session = await login(h);
    await expect(key(session.accessToken)).resolves.toBe(`user:${session.shop.id}:${session.user.id}`);

    await expect(key()).resolves.toBeNull();
    await expect(key('garbage')).resolves.toBeNull();
    await expect(key(await sessionToken(h, { alg: 'none' }))).resolves.toBeNull();
    await expect(key(await sessionToken(h, { secret: 'attacker-secret-attacker-secret-1234' }))).resolves.toBeNull();
    await expect(key(await sessionToken(h, { at: Date.now() - 600_000 }))).resolves.toBeNull();
    await expect(h.auth.service.rateLimitKey(asRequest('Basic abc'))).resolves.toBeNull();
    await expect(h.auth.service.rateLimitKey(asRequest(`Bearer ${session.accessToken} extra`))).resolves.toBeNull();
  });
});
