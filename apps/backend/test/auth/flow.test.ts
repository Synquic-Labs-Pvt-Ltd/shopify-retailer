import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { authSessionResponseSchema, errorEnvelopeSchema, meResponseSchema } from '@rs/shared';
import { sha256Hex } from '../../src/modules/auth/crypto';
import { LoginCodeModel, OAuthStateModel, SessionModel, UserModel } from '../../src/modules/auth/models';
import { ShopModel } from '../../src/modules/shops/model';
import { MONGO_START_TIMEOUT_MS, startTestMongo, type TestMongo } from '../helpers/mongo';
import { signedQueryString } from '../shopify/fake-shopify';
import { SHOP, createHarness, createPkce, exchange, login, loginForCode, startLogin, type Harness } from './support';

const SCOPES = 'read_products,read_files,write_files';
let mongo: TestMongo;
let h: Harness;

beforeAll(async () => {
  mongo = await startTestMongo('rs_auth');
  await Promise.all([ShopModel, UserModel, SessionModel, OAuthStateModel, LoginCodeModel].map((model) => model.init()));
}, MONGO_START_TIMEOUT_MS);

afterAll(async () => {
  await mongo.stop();
});

beforeEach(async () => {
  await mongo.clear();
  h = createHarness();
});

const tokenCalls = (harness: Harness) => harness.fake.calls.filter((call) => call.url.endsWith('/admin/oauth/access_token'));
const errorCode = (res: request.Response): string => errorEnvelopeSchema.parse(res.body).error.code;

function claimsOf(token: string): Record<string, unknown> {
  return JSON.parse(Buffer.from(token.split('.')[1] ?? '', 'base64url').toString('utf8')) as Record<string, unknown>;
}

describe('GET /auth/shopify/start', () => {
  it('sends an unknown shop through the offline phase', async () => {
    const pkce = createPkce();
    const before = Date.now();
    const location = new URL(await startLogin(h, pkce));

    expect(`${location.origin}${location.pathname}`).toBe(`https://${SHOP}/admin/oauth/authorize`);
    expect(location.searchParams.get('client_id')).toBe(h.env.SHOPIFY_API_KEY);
    expect(location.searchParams.get('scope')).toBe(SCOPES);
    expect(location.searchParams.get('redirect_uri')).toBe('https://studio.example.com/auth/shopify/callback');
    expect(location.searchParams.getAll('grant_options[]')).toEqual([]);

    const state = await OAuthStateModel.findOne({ nonce: location.searchParams.get('state') }).lean();
    expect(state).toMatchObject({ shopDomain: SHOP, phase: 'offline', codeChallenge: pkce.challenge });
    expect(state?.expiresAt.getTime()).toBeGreaterThanOrEqual(before + 10 * 60_000 - 1000);
    expect(state?.expiresAt.getTime()).toBeLessThanOrEqual(Date.now() + 10 * 60_000);
  });

  it('normalizes a bare store name', async () => {
    const res = await request(h.app).get('/auth/shopify/start').query({ shop: 'Demo-Store', challenge: createPkce().challenge });
    expect(res.status).toBe(302);
    expect(new URL(String(res.headers.location)).hostname).toBe(SHOP);
  });

  it('uses the online phase (per-user) for an installed shop with the required scopes', async () => {
    await h.shops.upsertFromOAuth({ shopDomain: SHOP, accessToken: 't', refreshToken: 'r', expiresInSeconds: 3600, refreshTokenExpiresInSeconds: 7776000, scope: SCOPES });
    const location = new URL(await startLogin(h, createPkce()));
    expect(location.searchParams.getAll('grant_options[]')).toEqual(['per-user']);
    expect(await OAuthStateModel.findOne({ nonce: location.searchParams.get('state') })).toMatchObject({ phase: 'online' });
  });

  it('falls back to the offline phase when the shop is uninstalled, needs re-login or lacks scopes', async () => {
    const grant = { shopDomain: SHOP, accessToken: 't', refreshToken: 'r', expiresInSeconds: 3600, refreshTokenExpiresInSeconds: 7776000 };
    const shop = await h.shops.upsertFromOAuth({ ...grant, scope: 'read_products' });
    expect(new URL(await startLogin(h, createPkce())).searchParams.getAll('grant_options[]')).toEqual([]);

    await h.shops.upsertFromOAuth({ ...grant, scope: SCOPES });
    await h.shops.markReauthRequired(shop.id);
    expect(new URL(await startLogin(h, createPkce())).searchParams.getAll('grant_options[]')).toEqual([]);

    await h.shops.upsertFromOAuth({ ...grant, scope: SCOPES });
    await h.shops.markUninstalled(SHOP);
    expect(new URL(await startLogin(h, createPkce())).searchParams.getAll('grant_options[]')).toEqual([]);
  });

  it.each([
    ['an invalid shop domain', { shop: 'evil.com', challenge: createPkce().challenge }],
    ['a domain with a path', { shop: 'demo.myshopify.com/evil', challenge: createPkce().challenge }],
    ['a missing shop', { challenge: createPkce().challenge }],
    ['a missing challenge', { shop: SHOP }],
    ['a malformed challenge', { shop: SHOP, challenge: 'short' }],
  ])('rejects %s with validation_failed', async (_label, query) => {
    const res = await request(h.app).get('/auth/shopify/start').query(query);
    expect(res.status).toBe(400);
    expect(errorCode(res)).toBe('validation_failed');
    expect(await OAuthStateModel.countDocuments()).toBe(0);
  });
});

describe('OAuth callback: offline then online then app', () => {
  it('completes install, login and PKCE exchange end to end', async () => {
    const pkce = createPkce();

    // 1. start -> offline authorize
    const offlineUrl = await startLogin(h, pkce);

    // 2. offline callback: tokens stored, shop info fetched, chained to the online phase
    const offline = await request(h.app).get(h.fake.approve(offlineUrl));
    expect(offline.status).toBe(302);
    const onlineUrl = new URL(String(offline.headers.location));
    expect(onlineUrl.hostname).toBe(SHOP);
    expect(onlineUrl.searchParams.getAll('grant_options[]')).toEqual(['per-user']);
    expect(onlineUrl.searchParams.get('state')).not.toBe(new URL(offlineUrl).searchParams.get('state'));

    const shop = await h.shops.getByDomain(SHOP);
    expect(shop).toMatchObject({
      status: 'active',
      scopes: ['read_products', 'read_files', 'write_files'],
      name: 'Demo Store',
      email: 'owner@demo.example',
      currencyCode: 'INR',
      ianaTimezone: 'Asia/Kolkata',
      shopGid: 'gid://shopify/Shop/1001',
    });
    const raw = await ShopModel.collection.findOne({ shopDomain: SHOP });
    expect(String((raw?.offlineToken as { accessTokenEnc: string }).accessTokenEnc)).not.toContain('shpat_');
    expect(await UserModel.countDocuments()).toBe(0);

    // The offline exchange asked for an expiring token; the online one did not.
    expect(tokenCalls(h)[0]?.form).toMatchObject({ expiring: '1', client_id: h.env.SHOPIFY_API_KEY });
    expect(tokenCalls(h)[0]?.form?.code).toBeTruthy();

    // 3. online callback: user upserted, login code created, redirect to the app
    const online = await request(h.app).get(h.fake.approve(onlineUrl.href));
    expect(online.status).toBe(302);
    const deepLink = new URL(String(online.headers.location));
    expect(deepLink.protocol).toBe('retailerstudio:');
    expect(deepLink.host).toBe('auth');
    const code = deepLink.searchParams.get('code') ?? '';
    expect(code).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(tokenCalls(h)[1]?.form?.expiring).toBeUndefined();

    const users = await UserModel.find().lean();
    expect(users).toHaveLength(1);
    expect(users[0]).toMatchObject({ shopifyUserId: '902541635', email: 'asha@example.com', firstName: 'Asha', lastName: 'Verma', accountOwner: true, collaborator: false });
    const stored = await LoginCodeModel.findOne().lean();
    expect(stored?.codeHash).toBe(sha256Hex(code));
    expect(stored?.codeChallenge).toBe(pkce.challenge);
    expect(stored?.expiresAt.getTime()).toBeLessThanOrEqual(Date.now() + 2 * 60_000);
    // The online token is discarded: nothing in the database carries it.
    expect(JSON.stringify(await ShopModel.collection.find().toArray())).not.toContain('shpat_online');

    // 4. PKCE exchange
    const res = await exchange(h, code, pkce);
    expect(res.status).toBe(200);
    const session = authSessionResponseSchema.parse(res.body);
    expect(session.user).toEqual({ id: String(users[0]?._id), email: 'asha@example.com', firstName: 'Asha', lastName: 'Verma' });
    expect(session.shop).toEqual({ id: shop?.id, domain: SHOP, name: 'Demo Store' });
    expect(claimsOf(session.accessToken)).toMatchObject({ sub: session.user.id, shopId: shop?.id, shopDomain: SHOP, typ: 'access' });
    const lifetimeMs = new Date(session.accessTokenExpiresAt).getTime() - Date.now();
    expect(lifetimeMs).toBeGreaterThan(14 * 60_000);
    expect(lifetimeMs).toBeLessThanOrEqual(15 * 60_000);

    // 5. the access token works
    const me = await request(h.app).get('/api/v1/me').set('authorization', `Bearer ${session.accessToken}`);
    expect(me.status).toBe(200);
    expect(meResponseSchema.parse(me.body).shop.domain).toBe(SHOP);
  });

  it('needs only the online hop for a later login on an installed shop', async () => {
    await login(h);
    const callsBefore = tokenCalls(h).length;
    const pkce = createPkce();
    const location = await startLogin(h, pkce);
    expect(new URL(location).searchParams.getAll('grant_options[]')).toEqual(['per-user']);

    const res = await request(h.app).get(h.fake.approve(location));
    expect(String(res.headers.location)).toMatch(/^retailerstudio:\/\/auth\?code=/);
    expect(tokenCalls(h)).toHaveLength(callsBefore + 1);
    expect(await UserModel.countDocuments()).toBe(1);
  });

  it('keeps a state single use', async () => {
    const location = await startLogin(h, createPkce());
    const callback = h.fake.approve(location);
    expect((await request(h.app).get(callback)).status).toBe(302);

    const replay = await request(h.app).get(callback);
    expect(replay.status).toBe(403);
    expect(errorCode(replay)).toBe('forbidden');
    expect(tokenCalls(h)).toHaveLength(1);
  });

  it('rejects an expired state', async () => {
    const callback = h.fake.approve(await startLogin(h, createPkce()));
    h.clock.offsetMs = 10 * 60_000 + 1000;

    const res = await request(h.app).get(callback);
    expect(res.status).toBe(403);
    expect(tokenCalls(h)).toHaveLength(0);
    expect(await ShopModel.countDocuments()).toBe(0);
  });

  it('rejects a bad HMAC without consuming the state', async () => {
    const callback = h.fake.approve(await startLogin(h, createPkce()));
    const tampered = callback.replace(/hmac=[0-9a-f]{4}/, 'hmac=0000');
    const bad = await request(h.app).get(tampered);
    expect(bad.status).toBe(403);
    expect(errorCode(bad)).toBe('forbidden');
    expect(tokenCalls(h)).toHaveLength(0);

    expect((await request(h.app).get(callback)).status).toBe(302);
  });

  it('rejects a callback signed with another secret, and one with no hmac', async () => {
    const callback = h.fake.approve(await startLogin(h, createPkce()));
    const params = Object.fromEntries(new URL(callback, 'https://x').searchParams);
    const { hmac: _hmac, ...unsigned } = params;
    const forged = `/auth/shopify/callback?${signedQueryString(unsigned, 'attacker-secret')}`;
    expect((await request(h.app).get(forged)).status).toBe(403);
    expect((await request(h.app).get(`/auth/shopify/callback?${new URLSearchParams(unsigned)}`)).status).toBe(400);
  });

  it('rejects an unknown state and a state issued for another shop', async () => {
    const params = { code: 'c', shop: SHOP, state: 'never-issued', timestamp: '1760000000' };
    const unknown = await request(h.app).get(`/auth/shopify/callback?${signedQueryString(params, h.env.SHOPIFY_API_SECRET)}`);
    expect(unknown.status).toBe(403);

    const location = new URL(await startLogin(h, createPkce()));
    const mismatch = {
      code: 'c',
      shop: 'other-store.myshopify.com',
      state: location.searchParams.get('state') ?? '',
      timestamp: '1760000000',
    };
    const res = await request(h.app).get(`/auth/shopify/callback?${signedQueryString(mismatch, h.env.SHOPIFY_API_SECRET)}`);
    expect(res.status).toBe(403);
    expect(tokenCalls(h)).toHaveLength(0);
  });

  it('validates the shop hostname before doing anything else', async () => {
    const params = { code: 'c', shop: 'evil.com', state: 's', timestamp: '1760000000' };
    const res = await request(h.app).get(`/auth/shopify/callback?${signedQueryString(params, h.env.SHOPIFY_API_SECRET)}`);
    expect(res.status).toBe(400);
    expect(errorCode(res)).toBe('validation_failed');
  });

  it('hands the app an error when the merchant did not grant the required scopes', async () => {
    const location = await startLogin(h, createPkce());
    const res = await request(h.app).get(h.fake.approve(location, { scope: 'read_products' }));
    expect(res.status).toBe(302);
    expect(String(res.headers.location)).toBe('retailerstudio://auth?error=forbidden');
    expect(await ShopModel.countDocuments()).toBe(0);
  });

  it('accepts a write scope in place of the matching read scope', async () => {
    const location = await startLogin(h, createPkce());
    const res = await request(h.app).get(h.fake.approve(location, { scope: 'write_products,write_files' }));
    expect(String(res.headers.location)).toContain('grant_options');
  });

  it('hands the app an error when Shopify rejects the code', async () => {
    const callback = h.fake.approve(await startLogin(h, createPkce()));
    // Burn the code on the Shopify side first.
    const code = new URL(callback, 'https://x').searchParams.get('code') ?? '';
    await h.fake.fetchImpl(`https://${SHOP}/admin/oauth/access_token`, {
      method: 'POST',
      body: new URLSearchParams({ client_id: h.env.SHOPIFY_API_KEY, client_secret: h.env.SHOPIFY_API_SECRET, code, expiring: '1' }),
    });
    const res = await request(h.app).get(callback);
    expect(String(res.headers.location)).toBe('retailerstudio://auth?error=forbidden');
  });

  it('still logs in when the shop info query fails', async () => {
    h.fake.failShopQuery = true;
    const session = await login(h);
    expect(session.shop.name).toBe(SHOP);
    expect(await h.shops.getByDomain(SHOP)).toMatchObject({ status: 'active', name: null });
  });
});

describe('POST /api/v1/auth/exchange', () => {
  it('stores only hashes: the login code and the refresh token', async () => {
    const pkce = createPkce();
    const code = await loginForCode(h, pkce);
    const res = await exchange(h, code, pkce);
    const { refreshToken } = authSessionResponseSchema.parse(res.body);

    const sessionDoc = await SessionModel.findOne().lean();
    expect(sessionDoc?.refreshTokenHash).toBe(sha256Hex(refreshToken));
    expect(JSON.stringify(sessionDoc)).not.toContain(refreshToken);
    expect(sessionDoc).toMatchObject({ platform: 'android', deviceName: 'Pixel' });
    expect(sessionDoc?.expiresAt.getTime()).toBeGreaterThan(Date.now() + 29 * 24 * 3_600_000);
    expect(JSON.stringify(await LoginCodeModel.findOne().lean())).not.toContain(code);
  });

  it('makes the login code single use', async () => {
    const pkce = createPkce();
    const code = await loginForCode(h, pkce);
    expect((await exchange(h, code, pkce)).status).toBe(200);

    const replay = await exchange(h, code, pkce);
    expect(replay.status).toBe(401);
    expect(errorCode(replay)).toBe('unauthorized');
  });

  it('single-use holds under concurrent exchanges', async () => {
    const pkce = createPkce();
    const code = await loginForCode(h, pkce);
    const results = await Promise.all(Array.from({ length: 5 }, () => exchange(h, code, pkce)));
    expect(results.filter((res) => res.status === 200)).toHaveLength(1);
    expect(await SessionModel.countDocuments()).toBe(1);
  });

  it('rejects a wrong PKCE verifier and burns the code', async () => {
    const pkce = createPkce();
    const code = await loginForCode(h, pkce);
    const wrong = await exchange(h, code, createPkce());
    expect(wrong.status).toBe(401);
    expect((await exchange(h, code, pkce)).status).toBe(401);
    expect(await SessionModel.countDocuments()).toBe(0);
  });

  it('rejects an unknown or expired code', async () => {
    const pkce = createPkce();
    expect((await exchange(h, 'unknown-code', pkce)).status).toBe(401);

    const code = await loginForCode(h, pkce);
    h.clock.offsetMs = 2 * 60_000 + 1000;
    expect((await exchange(h, code, pkce)).status).toBe(401);
  });

  it('answers 409 shop_reauth_required when the shop was uninstalled meanwhile', async () => {
    const pkce = createPkce();
    const code = await loginForCode(h, pkce);
    await h.shops.markUninstalled(SHOP);
    const res = await exchange(h, code, pkce);
    expect(res.status).toBe(409);
    expect(errorCode(res)).toBe('shop_reauth_required');
  });

  it.each([
    ['a missing verifier', { code: 'c', platform: 'android' }],
    ['a short verifier', { code: 'c', codeVerifier: 'short', platform: 'android' }],
    ['an unknown platform', { code: 'c', codeVerifier: 'v'.repeat(43), platform: 'windows' }],
  ])('rejects %s with validation_failed', async (_label, body) => {
    const res = await request(h.app).post('/api/v1/auth/exchange').send(body);
    expect(res.status).toBe(400);
    expect(errorCode(res)).toBe('validation_failed');
  });
});

describe('POST /api/v1/auth/refresh and logout', () => {
  const refresh = (token: string) => request(h.app).post('/api/v1/auth/refresh').send({ refreshToken: token });

  it('rotates the refresh token inside one family', async () => {
    const first = await login(h);
    const res = await refresh(first.refreshToken);
    expect(res.status).toBe(200);
    const second = authSessionResponseSchema.parse(res.body);

    expect(second.refreshToken).not.toBe(first.refreshToken);
    expect(second.user).toEqual(first.user);
    const sessions = await SessionModel.find().sort({ _id: 1 }).lean();
    expect(sessions).toHaveLength(2);
    expect(sessions[0]?.familyId).toBe(sessions[1]?.familyId);
    expect(sessions[0]?.replacedBySessionId?.toHexString()).toBe(sessions[1]?._id.toHexString());
    expect(sessions[0]?.revokedAt).toBeTruthy();
    expect(sessions[1]?.revokedAt ?? null).toBeNull();
    expect((await request(h.app).get('/api/v1/me').set('authorization', `Bearer ${second.accessToken}`)).status).toBe(200);
  });

  it('revokes the whole family when a rotated token is presented again', async () => {
    const first = await login(h);
    const second = authSessionResponseSchema.parse((await refresh(first.refreshToken)).body);
    const third = authSessionResponseSchema.parse((await refresh(second.refreshToken)).body);

    const reuse = await refresh(first.refreshToken);
    expect(reuse.status).toBe(401);
    expect(errorCode(reuse)).toBe('unauthorized');

    // The legitimate holder of the newest token is revoked too.
    expect((await refresh(third.refreshToken)).status).toBe(401);
    expect(await SessionModel.countDocuments({ revokedAt: null })).toBe(0);
  });

  it('only revokes the family that was reused, not the user\'s other devices', async () => {
    const phone = await login(h);
    const tablet = await login(h);
    const rotated = authSessionResponseSchema.parse((await refresh(phone.refreshToken)).body);
    expect((await refresh(phone.refreshToken)).status).toBe(401);

    expect((await refresh(rotated.refreshToken)).status).toBe(401);
    expect((await refresh(tablet.refreshToken)).status).toBe(200);
  });

  it('accepts exactly one of two concurrent refreshes with the same token', async () => {
    const first = await login(h);
    const results = await Promise.all([refresh(first.refreshToken), refresh(first.refreshToken)]);
    expect(results.filter((res) => res.status === 200)).toHaveLength(1);
    expect(results.filter((res) => res.status === 401)).toHaveLength(1);
    // The race is treated as reuse, so no session of the family survives.
    expect(await SessionModel.countDocuments({ revokedAt: null })).toBe(0);
  });

  it('rejects unknown and expired refresh tokens', async () => {
    expect((await refresh('unknown-token')).status).toBe(401);
    const session = await login(h);
    h.clock.offsetMs = 30 * 24 * 3_600_000 + 1000;
    expect((await refresh(session.refreshToken)).status).toBe(401);
  });

  it('answers 409 shop_reauth_required when the shop is not active', async () => {
    const session = await login(h);
    await h.shops.markUninstalled(SHOP);
    const res = await refresh(session.refreshToken);
    expect(res.status).toBe(409);
    expect(errorCode(res)).toBe('shop_reauth_required');
  });

  it('logout revokes the session without needing an access token', async () => {
    const session = await login(h);
    const res = await request(h.app).post('/api/v1/auth/logout').send({ refreshToken: session.refreshToken });
    expect(res.status).toBe(204);
    expect((await refresh(session.refreshToken)).status).toBe(401);

    const unknown = await request(h.app).post('/api/v1/auth/logout').send({ refreshToken: 'unknown-token' });
    expect(unknown.status).toBe(204);
  });

  it('logout after a rotation revokes the current session', async () => {
    const first = await login(h);
    const second = authSessionResponseSchema.parse((await refresh(first.refreshToken)).body);
    expect((await request(h.app).post('/api/v1/auth/logout').send({ refreshToken: second.refreshToken })).status).toBe(204);
    expect((await refresh(second.refreshToken)).status).toBe(401);
  });

  it('validates the body', async () => {
    const res = await request(h.app).post('/api/v1/auth/refresh').send({});
    expect(res.status).toBe(400);
    expect(errorCode(res)).toBe('validation_failed');
  });
});

describe('requireAuth and GET /api/v1/me', () => {
  const me = (token?: string) => {
    const req = request(h.app).get('/api/v1/me');
    return token === undefined ? req : req.set('authorization', `Bearer ${token}`);
  };

  it('returns a body that validates against the shared me schema', async () => {
    const session = await login(h);
    const res = await me(session.accessToken);
    expect(res.status).toBe(200);
    const body = meResponseSchema.parse(res.body);
    expect(body.user.email).toBe('asha@example.com');
    expect(body.shop).toEqual({ id: session.shop.id, domain: SHOP, name: 'Demo Store' });
    expect(body.generation).toMatchObject({
      imagesPerProduct: 2,
      videosPerProduct: 1,
      maxProductsPerBatch: 50,
      references: { maxPerProduct: 5, maxCommon: 10 },
    });
    expect(res.headers['cache-control']).toBe('no-store');
  });

  it('falls back to the domain as the shop name', async () => {
    h.fake.failShopQuery = true;
    const session = await login(h);
    const body = meResponseSchema.parse((await me(session.accessToken)).body);
    expect(body.shop.name).toBe(SHOP);
  });

  it('answers 401 unauthorized for a missing, malformed, tampered or expired token', async () => {
    const session = await login(h);
    for (const res of [
      await me(),
      await me('garbage'),
      await me(`${session.accessToken}x`),
      await request(h.app).get('/api/v1/me').set('authorization', `Basic ${session.accessToken}`),
    ]) {
      expect(res.status).toBe(401);
      expect(errorCode(res)).toBe('unauthorized');
    }

    h.clock.offsetMs = 15 * 60_000 + 1000;
    expect((await me(session.accessToken)).status).toBe(401);
  });

  it('answers 409 shop_reauth_required when the shop is uninstalled or needs a new login', async () => {
    const session = await login(h);
    await h.shops.markReauthRequired(session.shop.id);
    const reauth = await me(session.accessToken);
    expect(reauth.status).toBe(409);
    expect(errorCode(reauth)).toBe('shop_reauth_required');

    await h.shops.markUninstalled(SHOP);
    expect((await me(session.accessToken)).status).toBe(409);
  });

  it('exposes verifyAccessToken and sets req.auth', async () => {
    const session = await login(h);
    await expect(h.auth.service.verifyAccessToken(session.accessToken)).resolves.toEqual({
      userId: session.user.id,
      shopId: session.shop.id,
      shopDomain: SHOP,
    });
    await expect(h.auth.service.verifyAccessToken('nope')).rejects.toMatchObject({ code: 'unauthorized' });
  });
});

describe('GET / landing page', () => {
  const signedLanding = (shop: string, secret = h.env.SHOPIFY_API_SECRET, extra: Record<string, string> = {}) =>
    `/?${signedQueryString({ shop, timestamp: '1760000000', host: 'YWRtaW4', ...extra }, secret)}`;

  it('shows the installed page for an installed shop', async () => {
    await login(h);
    const res = await request(h.app).get(signedLanding(SHOP));
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('text/html');
    expect(res.text).toContain(`Retailer Studio is installed on ${SHOP}. Open the Retailer Studio app on your phone and log in with ${SHOP}.`);
  });

  it('starts the offline phase when the shop is not installed, and ends on the installed page', async () => {
    const res = await request(h.app).get(signedLanding(SHOP));
    expect(res.status).toBe(302);
    const location = new URL(String(res.headers.location));
    expect(location.pathname).toBe('/admin/oauth/authorize');
    expect(location.searchParams.getAll('grant_options[]')).toEqual([]);
    expect(await OAuthStateModel.findOne({ nonce: location.searchParams.get('state') })).toMatchObject({ phase: 'offline', codeChallenge: null });

    const callback = await request(h.app).get(h.fake.approve(location.href));
    expect(callback.status).toBe(200);
    expect(callback.text).toContain(`Retailer Studio is installed on ${SHOP}`);
    expect(await h.shops.getByDomain(SHOP)).toMatchObject({ status: 'active', name: 'Demo Store' });
    expect(tokenCalls(h)).toHaveLength(1);
  });

  it('restarts the offline phase for an uninstalled shop', async () => {
    await login(h);
    await h.shops.markUninstalled(SHOP);
    const res = await request(h.app).get(signedLanding(SHOP));
    expect(res.status).toBe(302);
    expect(String(res.headers.location)).toContain('/admin/oauth/authorize');
  });

  it('verifies the HMAC', async () => {
    await login(h);
    const forged = await request(h.app).get(signedLanding(SHOP, 'attacker-secret'));
    expect(forged.status).toBe(403);
    expect(errorCode(forged)).toBe('forbidden');

    const statesBefore = await OAuthStateModel.countDocuments();
    const tampered = signedLanding(SHOP).replace('1760000000', '1760000001');
    expect((await request(h.app).get(tampered)).status).toBe(403);
    expect(await OAuthStateModel.countDocuments()).toBe(statesBefore);
  });

  it('rejects a missing query and an invalid shop domain', async () => {
    expect((await request(h.app).get('/')).status).toBe(400);
    const res = await request(h.app).get(signedLanding('evil.com'));
    expect(res.status).toBe(400);
    expect(errorCode(res)).toBe('validation_failed');
  });
});

describe('AuthService lifecycle', () => {
  it('revokeAllSessions revokes every session and burns outstanding login codes', async () => {
    const session = await login(h);
    const pkce = createPkce();
    const pendingCode = await loginForCode(h, pkce);

    await h.auth.service.revokeAllSessions(session.shop.id);

    expect(await SessionModel.countDocuments({ revokedAt: null })).toBe(0);
    expect((await request(h.app).post('/api/v1/auth/refresh').send({ refreshToken: session.refreshToken })).status).toBe(401);
    expect((await exchange(h, pendingCode, pkce)).status).toBe(401);
  });

  it('purgeShop deletes the shop\'s users, sessions, login codes and oauth states and nothing else', async () => {
    const mine = await login(h);
    const other = await login(h, { user: { id: 7 } }, 'other-store.myshopify.com');
    await startLogin(h, createPkce());

    await h.auth.service.purgeShop(mine.shop.id);

    expect(await UserModel.countDocuments({ shopId: mine.shop.id })).toBe(0);
    expect(await SessionModel.countDocuments({ shopId: mine.shop.id })).toBe(0);
    expect(await LoginCodeModel.countDocuments({ shopId: mine.shop.id })).toBe(0);
    expect(await OAuthStateModel.countDocuments({ shopDomain: SHOP })).toBe(0);
    expect(await UserModel.countDocuments({ shopId: other.shop.id })).toBe(1);
    expect(await SessionModel.countDocuments({ shopId: other.shop.id })).toBe(1);
    expect(await OAuthStateModel.countDocuments({ shopDomain: 'other-store.myshopify.com' })).toBe(2);
  });
});

describe('rate limiting', () => {
  it('limits the auth routes per IP and leaves /me alone', async () => {
    const limited = createHarness({ rateLimitPerMinute: 3 });
    for (let i = 0; i < 3; i++) {
      expect((await request(limited.app).post('/api/v1/auth/refresh').send({ refreshToken: 'x' })).status).toBe(401);
    }
    const res = await request(limited.app).post('/api/v1/auth/refresh').send({ refreshToken: 'x' });
    expect(res.status).toBe(429);
    expect(errorCode(res)).toBe('too_many_requests');
    // The limiter is shared by every auth route.
    expect((await request(limited.app).get('/auth/shopify/start').query({ shop: SHOP, challenge: createPkce().challenge })).status).toBe(429);
    expect((await request(limited.app).get('/api/v1/me')).status).toBe(401);
  });

  it('defaults to 30 requests per minute', async () => {
    const standard = createHarness({ rateLimitPerMinute: undefined });
    const statuses: number[] = [];
    for (let i = 0; i < 31; i++) {
      statuses.push((await request(standard.app).post('/api/v1/auth/logout').send({ refreshToken: 'x' })).status);
    }
    expect(statuses.slice(0, 30).every((status) => status === 204)).toBe(true);
    expect(statuses[30]).toBe(429);
  });
});
