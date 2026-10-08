import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { AppError } from '../../src/core/errors';
import { parseEnv } from '../../src/core/env';
import { createLogger } from '../../src/core/logger';
import { createShopsModule, type OAuthTokenGrant, type ShopsInternalService } from '../../src/modules/shops';
import { ShopModel } from '../../src/modules/shops/model';
import { MONGO_START_TIMEOUT_MS, startTestMongo, type TestMongo } from '../helpers/mongo';
import { EXCHANGE_GRANT, ID_TOKEN_TYPE, OFFLINE_TOKEN_TYPE, signSessionToken } from '../helpers/session-token';
import { createFakeShopify, type FakeShopify } from '../shopify/fake-shopify';

// ensureOfflineToken: the token exchange of the embedded app, with a real (in-memory) MongoDB and an injected fetch.

const env = parseEnv({});
const logger = createLogger('silent');
const DOMAIN = 'demo-store.myshopify.com';
const SCOPES = 'read_products,read_files,write_files';

let mongo: TestMongo;
let fake: FakeShopify;
let fetchSpy: ReturnType<typeof vi.fn<typeof fetch>>;

beforeAll(async () => {
  mongo = await startTestMongo('rs_shops_exchange');
  await ShopModel.init();
}, MONGO_START_TIMEOUT_MS);

afterAll(async () => {
  await mongo.stop();
});

beforeEach(async () => {
  await mongo.clear();
  fake = createFakeShopify({ apiKey: env.SHOPIFY_API_KEY, apiSecret: env.SHOPIFY_API_SECRET, apiVersion: env.SHOPIFY_API_VERSION });
  fetchSpy = vi.fn<typeof fetch>((input, init) => fake.fetchImpl(input, init));
});

const build = (): ShopsInternalService => createShopsModule({ env, logger, fetchImpl: fetchSpy, lockPollMs: 10 }).service;

const idToken = (shop = DOMAIN, sub: string | number = 902541635): Promise<string> =>
  signSessionToken({ shop, sub, apiKey: env.SHOPIFY_API_KEY, apiSecret: env.SHOPIFY_API_SECRET });

function grant(overrides: Partial<OAuthTokenGrant> = {}): OAuthTokenGrant {
  return {
    shopDomain: DOMAIN,
    accessToken: 'shpat_old',
    refreshToken: 'shprt_old',
    expiresInSeconds: 3600,
    refreshTokenExpiresInSeconds: 7_776_000,
    scope: SCOPES,
    ...overrides,
  };
}

const exchangeCalls = () => fake.exchangeCalls();
const rawShop = () => ShopModel.collection.findOne({ shopDomain: DOMAIN });

describe('a shop that already has a usable offline token', () => {
  it('is returned as it is, without asking Shopify', async () => {
    const shops = build();
    const stored = await shops.upsertFromOAuth(grant());
    await expect(shops.ensureOfflineToken(DOMAIN, await idToken())).resolves.toEqual(stored);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('is left alone while its access token is about to expire but the refresh token is alive', async () => {
    const shops = build();
    await shops.upsertFromOAuth(grant({ expiresInSeconds: 60 }));
    await expect(shops.ensureOfflineToken(DOMAIN, await idToken())).resolves.toMatchObject({ status: 'active' });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('is left alone when the token never expires', async () => {
    const shops = build();
    await shops.upsertFromOAuth(grant({ refreshToken: null, expiresInSeconds: null, refreshTokenExpiresInSeconds: null }));
    await shops.ensureOfflineToken(DOMAIN, await idToken());
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('matches the domain case-insensitively', async () => {
    const shops = build();
    await shops.upsertFromOAuth(grant());
    await shops.ensureOfflineToken(DOMAIN.toUpperCase(), await idToken());
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe('a shop that needs a token', () => {
  it('exchanges the session token for an expiring offline token and activates an unknown shop', async () => {
    const shops = build();
    const token = await idToken();
    const before = Date.now();
    const shop = await shops.ensureOfflineToken(DOMAIN, token);

    expect(shop).toMatchObject({ shopDomain: DOMAIN, status: 'active', scopes: ['read_products', 'read_files', 'write_files'] });
    // Shop info comes from the same shop query as the OAuth callback.
    expect(shop).toMatchObject({ name: 'Demo Store', shopGid: 'gid://shopify/Shop/1001', currencyCode: 'INR', ianaTimezone: 'Asia/Kolkata' });

    // The documented request: form encoded, token exchange grant, expiring offline token.
    expect(exchangeCalls()).toHaveLength(1);
    const [call] = exchangeCalls();
    expect(call?.url).toBe(`https://${DOMAIN}/admin/oauth/access_token`);
    expect(call?.method).toBe('POST');
    expect(call?.headers['content-type']).toBe('application/x-www-form-urlencoded');
    expect(call?.form).toEqual({
      client_id: env.SHOPIFY_API_KEY,
      client_secret: env.SHOPIFY_API_SECRET,
      grant_type: EXCHANGE_GRANT,
      subject_token: token,
      subject_token_type: ID_TOKEN_TYPE,
      requested_token_type: OFFLINE_TOKEN_TYPE,
      expiring: '1',
    });

    const raw = await rawShop();
    const stored = raw?.offlineToken as Record<string, unknown>;
    // Sealed (iv:tag:cipher), never in clear.
    expect(JSON.stringify(raw)).not.toMatch(/shp(at|rt)_/);
    expect(String(stored.accessTokenEnc).split(':')).toHaveLength(3);
    expect(String(stored.refreshTokenEnc).split(':')).toHaveLength(3);
    expect((stored.accessTokenExpiresAt as Date).getTime() - before).toBeGreaterThan(3_500_000);
    expect((stored.accessTokenExpiresAt as Date).getTime() - before).toBeLessThanOrEqual(3_601_000);
    expect((stored.refreshTokenExpiresAt as Date).getTime() - before).toBeGreaterThan(7_700_000 * 1000);
    expect(stored.refreshLockUntil).toBeNull();
    expect(raw?.installedAt).toBeInstanceOf(Date);

    // The stored token is the one Shopify issued: the Admin API accepts it.
    const accessToken = await shops.getAccessToken(shop.id);
    expect(accessToken).toMatch(/^shpat_offline_/);
    expect(await ShopModel.countDocuments()).toBe(1);

    // A second call finds the shop usable and does not exchange again.
    await shops.ensureOfflineToken(DOMAIN, await idToken());
    expect(exchangeCalls()).toHaveLength(1);
  });

  it('stores the scopes that the token response reports', async () => {
    fake.exchange.scope = 'read_products';
    const shop = await build().ensureOfflineToken(DOMAIN, await idToken());
    expect(shop.scopes).toEqual(['read_products']);
  });

  it('still activates the shop when the shop query fails', async () => {
    fake.failShopQuery = true;
    const shop = await build().ensureOfflineToken(DOMAIN, await idToken());
    expect(shop).toMatchObject({ status: 'active', name: null, shopGid: null });
  });

  it('brings back an uninstalled shop (reinstall) and clears the uninstall markers', async () => {
    const shops = build();
    const first = await shops.upsertFromOAuth(grant());
    await shops.markUninstalled(DOMAIN);
    const beforeRaw = await rawShop();
    expect(beforeRaw?.redactAfter).toBeInstanceOf(Date);
    await new Promise((resolve) => setTimeout(resolve, 15));

    const again = await shops.ensureOfflineToken(DOMAIN, await idToken());
    expect(again).toMatchObject({ id: first.id, status: 'active' });
    expect(exchangeCalls()).toHaveLength(1);
    const raw = await rawShop();
    expect(raw?.redactAfter).toBeUndefined();
    expect(raw?.uninstalledAt).toBeUndefined();
    expect((raw?.installedAt as Date).getTime()).toBeGreaterThan((beforeRaw?.installedAt as Date).getTime());
    await expect(shops.getAccessToken(first.id)).resolves.toMatch(/^shpat_offline_/);
  });

  it('brings back a shop that needs a new login', async () => {
    const shops = build();
    const shop = await shops.upsertFromOAuth(grant());
    await shops.markReauthRequired(shop.id);
    await expect(shops.ensureOfflineToken(DOMAIN, await idToken())).resolves.toMatchObject({ id: shop.id, status: 'active' });
    expect(exchangeCalls()).toHaveLength(1);
  });

  it('exchanges when the access token is about to expire and the refresh token is already dead', async () => {
    const shops = build();
    await shops.upsertFromOAuth(grant({ expiresInSeconds: 120, refreshTokenExpiresInSeconds: -60 }));
    await shops.ensureOfflineToken(DOMAIN, await idToken());
    expect(exchangeCalls()).toHaveLength(1);
    expect(fetchSpy.mock.calls.every(([, init]) => new URLSearchParams(String(init?.body)).get('grant_type') !== 'refresh_token')).toBe(true);
  });

  it('exchanges when the shop is active but has no tokens at all', async () => {
    await ShopModel.create({ shopDomain: DOMAIN, status: 'active', scopes: [] });
    await build().ensureOfflineToken(DOMAIN, await idToken());
    expect(exchangeCalls()).toHaveLength(1);
  });

  it('refuses an invalid shop domain without calling Shopify', async () => {
    const shops = build();
    for (const bad of ['evil.example.com', 'demo-store.myshopify.com.evil.com', '', 'a/b.myshopify.com']) {
      await expect(shops.ensureOfflineToken(bad, 'token')).rejects.toMatchObject({ code: 'unauthorized' });
    }
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(await ShopModel.countDocuments()).toBe(0);
  });
});

describe('single flight', () => {
  it('sends one exchange for 12 concurrent callers in one process, each with its own session token', async () => {
    fake.exchange.delayMs = 120;
    const shops = build();
    const tokens = await Promise.all(Array.from({ length: 12 }, (_, i) => idToken(DOMAIN, 1000 + i)));

    const inFlight = shops.ensureOfflineToken(DOMAIN, tokens[0] ?? '');
    // While the exchange runs, the shop is not visible as active.
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(await shops.getByDomain(DOMAIN)).toMatchObject({ status: 'uninstalled' });
    const rest = tokens.slice(1).map((token) => shops.ensureOfflineToken(DOMAIN, token));
    const results = await Promise.all([inFlight, ...rest]);

    expect(exchangeCalls()).toHaveLength(1);
    expect(new Set(results.map((shop) => shop.id)).size).toBe(1);
    expect(results.every((shop) => shop.status === 'active')).toBe(true);
    expect(await ShopModel.countDocuments()).toBe(1);
  });

  it('sends one exchange when three instances sharing the database race', async () => {
    fake.exchange.delayMs = 150;
    const instances = [build(), build(), build()];
    const tokens = await Promise.all(Array.from({ length: 9 }, (_, i) => idToken(DOMAIN, 2000 + i)));

    const results = await Promise.all(tokens.map((token, i) => instances[i % instances.length]?.ensureOfflineToken(DOMAIN, token)));

    expect(exchangeCalls()).toHaveLength(1);
    expect(results.every((shop) => shop?.status === 'active')).toBe(true);
    expect(await ShopModel.countDocuments()).toBe(1);
    expect(((await rawShop())?.offlineToken as { refreshLockUntil: unknown }).refreshLockUntil).toBeNull();
  });

  it('shares a refusal among the concurrent callers and asks Shopify once', async () => {
    fake.exchange.delayMs = 80;
    fake.exchange.refuse.add(DOMAIN);
    const shops = build();
    const tokens = await Promise.all(Array.from({ length: 6 }, (_, i) => idToken(DOMAIN, 3000 + i)));
    const results = await Promise.allSettled(tokens.map((token) => shops.ensureOfflineToken(DOMAIN, token)));

    expect(results.every((result) => result.status === 'rejected')).toBe(true);
    for (const result of results) expect(result).toMatchObject({ reason: { code: 'shop_reauth_required', status: 409 } });
    expect(exchangeCalls()).toHaveLength(1);
    expect(await ShopModel.countDocuments()).toBe(0);
  });

  it('waits while another instance holds the lock and uses the tokens it stored, without exchanging', async () => {
    const shops = build();
    const other = build();
    await shops.upsertFromOAuth(grant({ refreshTokenExpiresInSeconds: -60, expiresInSeconds: 60 }));
    await ShopModel.updateOne({ shopDomain: DOMAIN }, { $set: { 'offlineToken.refreshLockUntil': new Date(Date.now() + 30_000) } });

    const pending = shops.ensureOfflineToken(DOMAIN, await idToken());
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(fetchSpy).not.toHaveBeenCalled();
    // The holder finishes its exchange: new tokens stored, lock cleared.
    await other.upsertFromOAuth(grant({ accessToken: 'shpat_from_other', expiresInSeconds: 3600 }));

    await expect(pending).resolves.toMatchObject({ status: 'active' });
    expect(fetchSpy).not.toHaveBeenCalled();
    await expect(shops.getAccessToken((await shops.getByDomain(DOMAIN))?.id ?? '')).resolves.toBe('shpat_from_other');
  });

  it('takes over the lock of an exchange whose process died', async () => {
    const shops = build();
    await shops.upsertFromOAuth(grant({ refreshToken: null, expiresInSeconds: 60, refreshTokenExpiresInSeconds: null }));
    await ShopModel.updateOne({ shopDomain: DOMAIN }, { $set: { 'offlineToken.refreshLockUntil': new Date(Date.now() - 1000) } });
    await shops.ensureOfflineToken(DOMAIN, await idToken());
    expect(exchangeCalls()).toHaveLength(1);
  });

  it('does not exchange while a refresh is due: the refresh path owns a shop whose refresh token is alive', async () => {
    const shops = build();
    const shop = await shops.ensureOfflineToken(DOMAIN, await idToken());
    const firstToken = await shops.getAccessToken(shop.id);
    // The access token is due for a refresh; the refresh request takes a while.
    await ShopModel.updateOne({ shopDomain: DOMAIN }, { $set: { 'offlineToken.accessTokenExpiresAt': new Date(Date.now() + 60_000) } });
    fake.calls.splice(0);
    fetchSpy.mockImplementation(async (input, init) => {
      if (new URLSearchParams(String(init?.body)).get('grant_type') === 'refresh_token') await new Promise((resolve) => setTimeout(resolve, 100));
      return fake.fetchImpl(input, init);
    });

    const [a, b, c, d] = await Promise.all([
      shops.ensureOfflineToken(DOMAIN, await idToken()),
      shops.getAccessToken(shop.id),
      shops.ensureOfflineToken(DOMAIN, await idToken()),
      shops.getAccessToken(shop.id),
    ]);

    expect([a.status, c.status]).toEqual(['active', 'active']);
    expect(b).toBe(d);
    expect(b).not.toBe(firstToken);
    const grants = fake.calls.map((call) => call.form?.grant_type);
    expect(grants.filter((grantType) => grantType === 'refresh_token')).toHaveLength(1);
    expect(grants.filter((grantType) => grantType === EXCHANGE_GRANT)).toHaveLength(0);
  });
});

describe('when Shopify says no or is unavailable', () => {
  it('maps a refusal (400) to shop_reauth_required and leaves no shop behind', async () => {
    fake.exchange.refuse.add(DOMAIN);
    const error: unknown = await build().ensureOfflineToken(DOMAIN, await idToken()).catch((err: unknown) => err);
    expect(error).toBeInstanceOf(AppError);
    expect(error).toMatchObject({ code: 'shop_reauth_required', status: 409 });
    expect(await ShopModel.countDocuments()).toBe(0);
  });

  it('keeps an uninstalled shop uninstalled, wipes nothing and releases the lock', async () => {
    const shops = build();
    await shops.upsertFromOAuth(grant());
    await shops.markUninstalled(DOMAIN);
    const before = await rawShop();
    fake.exchange.refuse.add(DOMAIN);

    await expect(shops.ensureOfflineToken(DOMAIN, await idToken())).rejects.toMatchObject({ code: 'shop_reauth_required' });
    const after = await rawShop();
    expect(after).toMatchObject({ status: 'uninstalled' });
    expect(after?.redactAfter).toEqual(before?.redactAfter);
    expect(after?.installedAt).toEqual(before?.installedAt);
    expect(after?.offlineToken?.accessTokenEnc).toBeUndefined();
    expect(after?.offlineToken?.refreshLockUntil ?? null).toBeNull();

    // Reinstalled later: the next request works.
    fake.exchange.refuse.clear();
    await expect(shops.ensureOfflineToken(DOMAIN, await idToken())).resolves.toMatchObject({ status: 'active' });
  });

  it('rejects a session token that is not valid for the shop (400 from Shopify)', async () => {
    const wrongShop = await idToken('other-store.myshopify.com');
    await expect(build().ensureOfflineToken(DOMAIN, wrongShop)).rejects.toMatchObject({ code: 'shop_reauth_required' });
    expect(await ShopModel.countDocuments()).toBe(0);
  });

  it.each([
    ['a 503 response', 503],
    ['a 429 response', 429],
  ])('turns %s into a 502 and keeps the shop as it was', async (_label, status) => {
    const shops = build();
    const stored = await shops.upsertFromOAuth(grant({ expiresInSeconds: 120, refreshTokenExpiresInSeconds: -60 }));
    fake.exchange.forceStatus = status;

    const error: unknown = await shops.ensureOfflineToken(DOMAIN, await idToken()).catch((err: unknown) => err);
    expect(error).toMatchObject({ code: 'internal', status: 502, details: { upstream: 'shopify', reason: `HTTP ${status}` } });
    expect((await shops.getById(stored.id))?.status).toBe('active');
    expect(((await rawShop())?.offlineToken as { refreshLockUntil: unknown }).refreshLockUntil).toBeNull();

    fake.exchange.forceStatus = null;
    await expect(shops.ensureOfflineToken(DOMAIN, await idToken())).resolves.toMatchObject({ status: 'active' });
  });

  it('turns a network error into a 502 and removes the placeholder of an unknown shop', async () => {
    let down = true;
    fetchSpy.mockImplementation((input, init) => (down ? Promise.reject(new Error('socket hang up')) : fake.fetchImpl(input, init)));
    const shops = build();

    await expect(shops.ensureOfflineToken(DOMAIN, await idToken())).rejects.toMatchObject({ code: 'internal', status: 502 });
    expect(await ShopModel.countDocuments()).toBe(0);

    down = false;
    await expect(shops.ensureOfflineToken(DOMAIN, await idToken())).resolves.toMatchObject({ status: 'active' });
  });

  it('turns an unreadable success body into a 502', async () => {
    fetchSpy.mockImplementation(() => Promise.resolve(new Response(JSON.stringify({ unexpected: true }), { status: 200 })));
    await expect(build().ensureOfflineToken(DOMAIN, await idToken())).rejects.toMatchObject({ code: 'internal', status: 502 });
    expect(await ShopModel.countDocuments()).toBe(0);
  });

  it('tolerates a response without a refresh token (non-expiring offline token)', async () => {
    fetchSpy.mockImplementation((input, init) =>
      String(input).includes('graphql') ? fake.fetchImpl(input, init) : Promise.resolve(new Response(JSON.stringify({ access_token: 'shpat_plain', scope: SCOPES }), { status: 200 })),
    );
    const shops = build();
    const shop = await shops.ensureOfflineToken(DOMAIN, await idToken());
    expect(shop.status).toBe('active');
    await expect(shops.getAccessToken(shop.id)).resolves.toBe('shpat_plain');
  });
});
