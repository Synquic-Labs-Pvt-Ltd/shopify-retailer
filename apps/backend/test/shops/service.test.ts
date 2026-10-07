import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { AppError } from '../../src/core/errors';
import { parseEnv } from '../../src/core/env';
import { createLogger } from '../../src/core/logger';
import { createShopsModule, type OAuthTokenGrant, type ShopsInternalService } from '../../src/modules/shops';
import { ShopModel } from '../../src/modules/shops/model';
import { MONGO_START_TIMEOUT_MS, startTestMongo, type TestMongo } from '../helpers/mongo';

const env = parseEnv({});
const logger = createLogger('silent');
const DOMAIN = 'demo-store.myshopify.com';
const SCOPES = 'read_products,read_files,write_files';

let mongo: TestMongo;

beforeAll(async () => {
  mongo = await startTestMongo('rs_shops');
  await ShopModel.init();
}, MONGO_START_TIMEOUT_MS);

afterAll(async () => {
  await mongo.stop();
});

beforeEach(async () => {
  await mongo.clear();
});

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

function refreshBody(n: number): Record<string, unknown> {
  return {
    access_token: `shpat_new_${n}`,
    refresh_token: `shprt_new_${n}`,
    expires_in: 3600,
    refresh_token_expires_in: 7_776_000,
    scope: SCOPES,
  };
}

function grant(overrides: Partial<OAuthTokenGrant> = {}): OAuthTokenGrant {
  return {
    shopDomain: DOMAIN,
    accessToken: 'shpat_old',
    refreshToken: 'shprt_old',
    expiresInSeconds: 120,
    refreshTokenExpiresInSeconds: 7_776_000,
    scope: SCOPES,
    ...overrides,
  };
}

function build(fetchImpl: typeof fetch, extra: { lockPollMs?: number; refreshLockMs?: number } = {}): ShopsInternalService {
  return createShopsModule({ env, logger, fetchImpl, lockPollMs: 10, ...extra }).service;
}

function neverFetch(): ReturnType<typeof vi.fn<typeof fetch>> {
  return vi.fn<typeof fetch>(() => Promise.reject(new Error('fetch must not be called')));
}

describe('token storage', () => {
  it('stores tokens AES-GCM encrypted and returns a fresh token without refreshing', async () => {
    const fetchImpl = neverFetch();
    const shops = build(fetchImpl);
    const shop = await shops.upsertFromOAuth(grant({ expiresInSeconds: 3600 }));

    const raw = await ShopModel.collection.findOne({ shopDomain: DOMAIN });
    const stored = raw?.offlineToken as Record<string, unknown>;
    expect(String(stored.accessTokenEnc)).not.toContain('shpat_old');
    expect(String(stored.refreshTokenEnc)).not.toContain('shprt_old');
    expect(String(stored.accessTokenEnc).split(':')).toHaveLength(3);

    await expect(shops.getAccessToken(shop.id)).resolves.toBe('shpat_old');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('upserts an active shop with its scopes and keeps a non-expiring token usable', async () => {
    const fetchImpl = neverFetch();
    const shops = build(fetchImpl);
    const shop = await shops.upsertFromOAuth(grant({ refreshToken: null, expiresInSeconds: null, refreshTokenExpiresInSeconds: null }));
    expect(shop).toMatchObject({ shopDomain: DOMAIN, status: 'active', scopes: ['read_products', 'read_files', 'write_files'] });
    await expect(shops.getAccessToken(shop.id)).resolves.toBe('shpat_old');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('saves shop info', async () => {
    const shops = build(neverFetch());
    const shop = await shops.upsertFromOAuth(grant());
    const saved = await shops.saveShopInfo(shop.id, {
      shopGid: 'gid://shopify/Shop/1',
      name: 'Demo Store',
      email: 'owner@example.com',
      currencyCode: 'INR',
      ianaTimezone: 'Asia/Kolkata',
    });
    expect(saved).toMatchObject({ name: 'Demo Store', currencyCode: 'INR', ianaTimezone: 'Asia/Kolkata' });
    expect(await shops.getByDomain(DOMAIN)).toMatchObject({ shopGid: 'gid://shopify/Shop/1' });
  });
});

describe('getAccessToken refresh', () => {
  it('refreshes a token that expires within 5 minutes using the documented request and rotates the refresh token', async () => {
    let call = 0;
    const fetchImpl = vi.fn<typeof fetch>(() => Promise.resolve(json(200, refreshBody(++call))));
    const shops = build(fetchImpl);
    const shop = await shops.upsertFromOAuth(grant({ expiresInSeconds: 240 }));

    await expect(shops.getAccessToken(shop.id)).resolves.toBe('shpat_new_1');

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0] ?? [];
    expect(url).toBe(`https://${DOMAIN}/admin/oauth/access_token`);
    expect(init?.method).toBe('POST');
    const body = new URLSearchParams(String(init?.body));
    expect(Object.fromEntries(body)).toEqual({
      client_id: env.SHOPIFY_API_KEY,
      client_secret: env.SHOPIFY_API_SECRET,
      grant_type: 'refresh_token',
      refresh_token: 'shprt_old',
    });

    // The new token is fresh, so no second refresh; and the next refresh would present the rotated token.
    await expect(shops.getAccessToken(shop.id)).resolves.toBe('shpat_new_1');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    await ShopModel.updateOne({ shopDomain: DOMAIN }, { $set: { 'offlineToken.accessTokenExpiresAt': new Date(Date.now() + 60_000) } });
    await expect(shops.getAccessToken(shop.id)).resolves.toBe('shpat_new_2');
    expect(new URLSearchParams(String(fetchImpl.mock.calls[1]?.[1]?.body)).get('refresh_token')).toBe('shprt_new_1');
  });

  it('issues exactly one refresh request for concurrent callers in one instance', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => {
      await new Promise((resolve) => setTimeout(resolve, 120));
      return json(200, refreshBody(1));
    });
    const shops = build(fetchImpl);
    const shop = await shops.upsertFromOAuth(grant());

    const tokens = await Promise.all(Array.from({ length: 12 }, () => shops.getAccessToken(shop.id)));

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(new Set(tokens)).toEqual(new Set(['shpat_new_1']));
  });

  it('issues exactly one refresh request across separate service instances sharing the database', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => {
      await new Promise((resolve) => setTimeout(resolve, 120));
      return json(200, refreshBody(1));
    });
    const instances = [build(fetchImpl), build(fetchImpl), build(fetchImpl)];
    const shop = await instances[0]!.upsertFromOAuth(grant());

    const tokens = await Promise.all(
      Array.from({ length: 9 }, (_, i) => instances[i % instances.length]!.getAccessToken(shop.id)),
    );

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(new Set(tokens)).toEqual(new Set(['shpat_new_1']));
  });

  it('takes over a lock whose holder crashed', async () => {
    const fetchImpl = vi.fn<typeof fetch>(() => Promise.resolve(json(200, refreshBody(1))));
    const shops = build(fetchImpl);
    const shop = await shops.upsertFromOAuth(grant());
    await ShopModel.updateOne({ shopDomain: DOMAIN }, { $set: { 'offlineToken.refreshLockUntil': new Date(Date.now() - 1000) } });

    await expect(shops.getAccessToken(shop.id)).resolves.toBe('shpat_new_1');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('waits while another instance holds the lock and uses the token it stored', async () => {
    const fetchImpl = neverFetch();
    const shops = build(fetchImpl);
    const other = build(fetchImpl);
    const shop = await shops.upsertFromOAuth(grant());
    await ShopModel.updateOne({ shopDomain: DOMAIN }, { $set: { 'offlineToken.refreshLockUntil': new Date(Date.now() + 30_000) } });

    const pending = shops.getAccessToken(shop.id);
    await new Promise((resolve) => setTimeout(resolve, 60));
    // The other instance finishes its refresh: new tokens stored, lock cleared.
    await other.upsertFromOAuth(grant({ accessToken: 'shpat_from_other', expiresInSeconds: 3600 }));

    await expect(pending).resolves.toBe('shpat_from_other');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('discards a refresh result when an OAuth exchange replaced the tokens meanwhile', async () => {
    let shops: ShopsInternalService | undefined;
    const fetchImpl = vi.fn<typeof fetch>(async () => {
      await shops?.upsertFromOAuth(grant({ accessToken: 'shpat_oauth', refreshToken: 'shprt_oauth', expiresInSeconds: 3600 }));
      return json(200, refreshBody(1));
    });
    shops = build(fetchImpl);
    const shop = await shops.upsertFromOAuth(grant());

    await expect(shops.getAccessToken(shop.id)).resolves.toBe('shpat_oauth');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('sets reauth_required and wipes tokens when Shopify rejects the refresh token (401)', async () => {
    const fetchImpl = vi.fn<typeof fetch>(() =>
      Promise.resolve(json(401, { error: 'invalid_request', error_description: 'This request requires an active refresh_token' })),
    );
    const shops = build(fetchImpl);
    const shop = await shops.upsertFromOAuth(grant());

    await expect(shops.getAccessToken(shop.id)).rejects.toMatchObject({ code: 'shop_reauth_required', status: 409 });
    expect((await shops.getById(shop.id))?.status).toBe('reauth_required');
    const raw = await ShopModel.collection.findOne({ shopDomain: DOMAIN });
    expect(raw?.offlineToken).toBeUndefined();

    await expect(shops.getAccessToken(shop.id)).rejects.toMatchObject({ code: 'shop_reauth_required' });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('sets reauth_required without calling Shopify when the refresh token has expired', async () => {
    const fetchImpl = neverFetch();
    const shops = build(fetchImpl);
    const shop = await shops.upsertFromOAuth(grant({ refreshTokenExpiresInSeconds: -60 }));

    await expect(shops.getAccessToken(shop.id)).rejects.toMatchObject({ code: 'shop_reauth_required' });
    expect((await shops.getById(shop.id))?.status).toBe('reauth_required');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it.each([
    ['a 503 response', () => Promise.resolve(json(503, {}))],
    ['a 429 response', () => Promise.resolve(json(429, {}))],
    ['a network error', () => Promise.reject(new Error('socket hang up'))],
  ])('keeps the shop active, releases the lock and recovers after %s', async (_label, failure) => {
    let fail = true;
    const fetchImpl = vi.fn<typeof fetch>(() => (fail ? failure() : Promise.resolve(json(200, refreshBody(1)))));
    const shops = build(fetchImpl);
    const shop = await shops.upsertFromOAuth(grant());

    const error: unknown = await shops.getAccessToken(shop.id).catch((err: unknown) => err);
    expect(error).toBeInstanceOf(AppError);
    expect(error).toMatchObject({ code: 'internal', status: 502 });
    expect((await shops.getById(shop.id))?.status).toBe('active');
    const raw = await ShopModel.collection.findOne({ shopDomain: DOMAIN });
    expect((raw?.offlineToken as { refreshLockUntil: unknown }).refreshLockUntil).toBeNull();

    fail = false;
    await expect(shops.getAccessToken(shop.id)).resolves.toBe('shpat_new_1');
  });

  it('surfaces a permanent error (400) without marking the shop for re-login', async () => {
    const fetchImpl = vi.fn<typeof fetch>(() => Promise.resolve(json(400, { error: 'invalid_client' })));
    const shops = build(fetchImpl);
    const shop = await shops.upsertFromOAuth(grant());

    await expect(shops.getAccessToken(shop.id)).rejects.toMatchObject({ code: 'internal', status: 502 });
    expect((await shops.getById(shop.id))?.status).toBe('active');
  });

  it('refuses inactive and unknown shops', async () => {
    const fetchImpl = neverFetch();
    const shops = build(fetchImpl);
    const shop = await shops.upsertFromOAuth(grant());
    await shops.markUninstalled(DOMAIN);

    await expect(shops.getAccessToken(shop.id)).rejects.toMatchObject({ code: 'shop_reauth_required' });
    await expect(shops.getAccessToken('0'.repeat(24))).rejects.toMatchObject({ code: 'shop_reauth_required' });
    await expect(shops.getAccessToken('not-an-id')).rejects.toMatchObject({ code: 'shop_reauth_required' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe('lifecycle', () => {
  it('requireActive passes for active shops only', async () => {
    const shops = build(neverFetch());
    const shop = await shops.upsertFromOAuth(grant());
    await expect(shops.requireActive(shop.id)).resolves.toMatchObject({ id: shop.id });

    await shops.markReauthRequired(shop.id);
    await expect(shops.requireActive(shop.id)).rejects.toMatchObject({ code: 'shop_reauth_required' });
    await expect(shops.requireActive('f'.repeat(24))).rejects.toMatchObject({ code: 'shop_reauth_required' });
  });

  it('markUninstalled wipes tokens and schedules the redact 48 hours out, once', async () => {
    const shops = build(neverFetch());
    await shops.upsertFromOAuth(grant());

    const before = Date.now();
    const record = await shops.markUninstalled(DOMAIN.toUpperCase());
    expect(record).toMatchObject({ status: 'uninstalled', scopes: [] });

    const raw = await ShopModel.collection.findOne({ shopDomain: DOMAIN });
    expect(raw?.offlineToken).toBeUndefined();
    const redactAfter = (raw?.redactAfter as Date).getTime();
    expect(redactAfter - before).toBeGreaterThanOrEqual(48 * 3_600_000 - 1000);
    expect(redactAfter - before).toBeLessThan(48 * 3_600_000 + 10_000);

    await shops.markUninstalled(DOMAIN);
    const again = await ShopModel.collection.findOne({ shopDomain: DOMAIN });
    expect((again?.redactAfter as Date).getTime()).toBe(redactAfter);
    await expect(shops.markUninstalled('unknown.myshopify.com')).resolves.toBeNull();
  });

  it('a reinstall reactivates the shop and clears the uninstall markers', async () => {
    const shops = build(neverFetch());
    const first = await shops.upsertFromOAuth(grant());
    await shops.markUninstalled(DOMAIN);
    const rawBefore = await ShopModel.collection.findOne({ shopDomain: DOMAIN });

    await new Promise((resolve) => setTimeout(resolve, 15));
    const second = await shops.upsertFromOAuth(grant({ accessToken: 'shpat_again', expiresInSeconds: 3600 }));

    expect(second).toMatchObject({ id: first.id, status: 'active' });
    const raw = await ShopModel.collection.findOne({ shopDomain: DOMAIN });
    expect(raw?.redactAfter).toBeUndefined();
    expect(raw?.uninstalledAt).toBeUndefined();
    expect((raw?.installedAt as Date).getTime()).toBeGreaterThan((rawBefore?.installedAt as Date).getTime());
    await expect(shops.getAccessToken(second.id)).resolves.toBe('shpat_again');
  });

  it('purgeShop deletes the document', async () => {
    const shops = build(neverFetch());
    const shop = await shops.upsertFromOAuth(grant());
    await shops.purgeShop(shop.id);
    expect(await shops.getById(shop.id)).toBeNull();
    expect(await ShopModel.countDocuments()).toBe(0);
  });

  it('enforces a unique lowercase myshopify domain', async () => {
    const shops = build(neverFetch());
    await shops.upsertFromOAuth(grant());
    await expect(ShopModel.create({ shopDomain: 'evil.example.com', status: 'active' })).rejects.toThrow();
    await expect(ShopModel.create({ shopDomain: DOMAIN, status: 'active' })).rejects.toThrow(/duplicate key/);
  });
});
