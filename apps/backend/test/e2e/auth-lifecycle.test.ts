import { createHash } from 'node:crypto';
import { SignJWT } from 'jose';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { authSessionResponseSchema, meResponseSchema, productListResponseSchema } from '@rs/shared';
import { OAuthStateModel, SessionModel } from '../../src/modules/auth/models';
import { ShopModel } from '../../src/modules/shops/model';
import { signedQueryString } from '../shopify/fake-shopify';
import { apiClient, browserFlow, createPkce, defined, errorOf, exchangeRequest, login, withNewIp, type ApiClient } from './support/client';
import { MONGO_START_TIMEOUT_MS, startE2e, type E2e } from './support/harness';

const SHOP = 'auth-store.myshopify.com';
const FRESH_SHOP = 'fresh-store.myshopify.com';
const SECRET = 'e2e-api-secret';

let e2e: E2e;

beforeAll(async () => {
  e2e = await startE2e({ dbName: 'rs_e2e_auth' });
  e2e.stub.addShop(SHOP);
  e2e.stub.addShop(FRESH_SHOP);
}, MONGO_START_TIMEOUT_MS);

afterAll(async () => {
  await e2e.stop();
});

const get = (path: string): request.Test => withNewIp(request(e2e.app).get(path));
const post = (path: string, body: object): request.Test => withNewIp(request(e2e.app).post(path)).send(body);
const refresh = (refreshToken: string): request.Test => post('/api/v1/auth/refresh', { refreshToken });
const sha256 = (value: string): string => createHash('sha256').update(value).digest('hex');

async function startFlow(shop: string): Promise<{ authorizeUrl: string; callback: string; state: string }> {
  const start = await get('/auth/shopify/start').query({ shop, challenge: createPkce().challenge });
  const authorizeUrl = String(start.headers.location);
  return { authorizeUrl, callback: e2e.stub.approve(authorizeUrl), state: new URL(authorizeUrl).searchParams.get('state') ?? '' };
}

describe('the browser flow rejects what Shopify would not send', () => {
  it('refuses a callback with a bad signature and a replayed state', async () => {
    const flow = await startFlow(SHOP);
    const forged = await get(flow.callback.replace(/code=code_(\d+)/, 'code=code_99$1'));
    expect(forged.status).toBe(403);
    expect(errorOf(forged).code).toBe('forbidden');

    // The forged attempt did not use up the state: the real callback still works, exactly once.
    expect((await get(flow.callback)).status).toBe(302);
    const replay = await get(flow.callback);
    expect(replay.status).toBe(403);
    expect(await OAuthStateModel.countDocuments({ nonce: flow.state, consumedAt: { $ne: null } })).toBe(1);
  });

  it('refuses a callback whose shop is not the shop of the state', async () => {
    const flow = await startFlow(SHOP);
    const otherShop = `/auth/shopify/callback?${signedQueryString({ code: 'x', shop: FRESH_SHOP, state: flow.state, timestamp: '1760000000' }, SECRET)}`;
    expect((await get(otherShop)).status).toBe(403);
    expect((await get(`/auth/shopify/callback?${signedQueryString({ code: 'x', shop: SHOP, state: 'unknown-state', timestamp: '1760000000' }, SECRET)}`)).status).toBe(403);
  });

  it('rejects an invalid shop domain and a missing or malformed challenge', async () => {
    expect((await get('/auth/shopify/start').query({ shop: 'not a shop!', challenge: createPkce().challenge })).status).toBe(400);
    expect((await get('/auth/shopify/start').query({ shop: SHOP })).status).toBe(400);
    expect((await get('/auth/shopify/start').query({ shop: SHOP, challenge: 'short' })).status).toBe(400);
  });

  it('burns a login code that is presented with the wrong PKCE verifier', async () => {
    const flow = await browserFlow(e2e, SHOP);
    expect((await exchangeRequest(e2e, flow, { codeVerifier: createPkce().verifier })).status).toBe(401);
    expect((await exchangeRequest(e2e, flow)).status).toBe(401);
    expect((await post('/api/v1/auth/exchange', { code: 'nope', codeVerifier: flow.pkce.verifier, platform: 'android' })).status).toBe(401);
    expect((await post('/api/v1/auth/exchange', { code: flow.code })).status).toBe(400);
  });

  it('installs from the app url landing page without a waiting app', async () => {
    const signed = (shop: string): string => `/?${signedQueryString({ shop, timestamp: '1760000000', host: 'YWRtaW4' }, SECRET)}`;

    expect((await get(`/?shop=${FRESH_SHOP}&timestamp=1&hmac=${'0'.repeat(64)}`)).status).toBe(403);
    const landing = await get(signed(FRESH_SHOP));
    expect(landing.status).toBe(302);
    const authorize = new URL(String(landing.headers.location));
    expect(authorize.hostname).toBe(FRESH_SHOP);
    expect(authorize.searchParams.getAll('grant_options[]')).toEqual([]);

    const installed = await get(e2e.stub.approve(String(landing.headers.location)));
    expect(installed.status).toBe(200);
    expect(installed.text).toContain(`Retailer Studio is installed on ${FRESH_SHOP}`);
    expect(await ShopModel.findOne({ shopDomain: FRESH_SHOP }).lean()).toMatchObject({ status: 'active', name: 'Store 2' });

    const again = await get(signed(FRESH_SHOP));
    expect(again.status).toBe(200);
    expect(again.text).toContain(FRESH_SHOP);
  });
});

describe('access and refresh tokens', () => {
  let client: ApiClient;

  const forge = async (claims: { shopDomain?: string; typ?: string }, life: { iat: number; exp: number }, secret = e2e.env.JWT_SECRET): Promise<string> =>
    new SignJWT({ shopId: client.session.shop.id, shopDomain: claims.shopDomain ?? SHOP, typ: claims.typ ?? 'access' })
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject(client.session.user.id)
      .setIssuedAt(life.iat)
      .setExpirationTime(life.exp)
      .sign(new TextEncoder().encode(secret));

  const meWith = (token: string): request.Test => request(e2e.app).get('/api/v1/me').set('authorization', `Bearer ${token}`);

  it('answers 401 to expired, forged and malformed access tokens', async () => {
    client = await login(e2e, SHOP);
    const now = Math.floor(Date.now() / 1000);
    expect((await meWith(client.session.accessToken)).status).toBe(200);
    expect((await meWith(await forge({}, { iat: now, exp: now + 900 }))).status).toBe(200);

    const expired = await meWith(await forge({}, { iat: now - 7200, exp: now - 3600 }));
    expect(expired.status).toBe(401);
    expect(errorOf(expired).code).toBe('unauthorized');
    expect((await meWith(await forge({}, { iat: now, exp: now + 900 }, 'another-secret-another-secret-another-secret'))).status).toBe(401);
    expect((await meWith(await forge({ typ: 'refresh' }, { iat: now, exp: now + 900 }))).status).toBe(401);
    expect((await meWith(await forge({ shopDomain: 'other.myshopify.com' }, { iat: now, exp: now + 900 }))).status).toBe(401);
    expect((await meWith('garbage')).status).toBe(401);
    expect((await request(e2e.app).get('/api/v1/me').set('authorization', 'Basic abc')).status).toBe(401);
  });

  it('rotates the refresh token and keeps the session family', async () => {
    const before = client.session;
    const res = await refresh(before.refreshToken);
    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    const next = authSessionResponseSchema.parse(res.body);
    expect(next.refreshToken).not.toBe(before.refreshToken);
    expect(next.user.id).toBe(before.user.id);
    expect((await meWith(next.accessToken)).status).toBe(200);

    const previous = defined(await SessionModel.findOne({ refreshTokenHash: sha256(before.refreshToken) }).lean());
    const newest = defined(await SessionModel.findOne({ refreshTokenHash: sha256(next.refreshToken) }).lean());
    expect(newest.familyId).toBe(previous.familyId);
    expect(previous.replacedBySessionId).toEqual(newest._id);
    expect(previous.revokedAt).toBeInstanceOf(Date);
    expect(newest.revokedAt).toBeUndefined();
    client.session = next;
  });

  it('revokes the whole family when a rotated refresh token is presented again', async () => {
    const stale = client.session.refreshToken;
    const rotated = authSessionResponseSchema.parse((await refresh(stale)).body);

    expect((await refresh(stale)).status).toBe(401);
    // The reuse also killed the legitimate successor.
    expect((await refresh(rotated.refreshToken)).status).toBe(401);
    const familyId = defined(await SessionModel.findOne({ refreshTokenHash: sha256(rotated.refreshToken) }).lean()).familyId;
    const family = await SessionModel.find({ familyId }).lean();
    expect(family).toHaveLength(3);
    expect(family.every((session) => session.revokedAt instanceof Date)).toBe(true);
    expect(e2e.logs.some((line) => line.includes('refresh token reuse detected'))).toBe(true);
  });

  it('treats two concurrent rotations of one token as reuse', async () => {
    client = await login(e2e, SHOP);
    const results = await Promise.all([refresh(client.session.refreshToken), refresh(client.session.refreshToken)]);
    expect(results.map((res) => res.status).sort()).toEqual([200, 401]);
    const winner = authSessionResponseSchema.parse(defined(results.find((res) => res.status === 200)).body);
    expect((await refresh(winner.refreshToken)).status).toBe(401);
  });

  it('logs out with the refresh token alone and ignores unknown tokens', async () => {
    client = await login(e2e, SHOP);
    const other = await login(e2e, SHOP, { user: { id: 31337, email: 'second@example.com' } });
    // No Authorization header: the refresh token is the credential.
    expect((await post('/api/v1/auth/logout', { refreshToken: client.session.refreshToken })).status).toBe(204);
    expect((await refresh(client.session.refreshToken)).status).toBe(401);
    expect((await post('/api/v1/auth/logout', { refreshToken: 'never-issued' })).status).toBe(204);
    expect((await post('/api/v1/auth/logout', {})).status).toBe(400);
    // The other device keeps its session.
    expect((await refresh(other.session.refreshToken)).status).toBe(200);
  });
});

describe('Shopify offline token refresh through the API', () => {
  let client: ApiClient;
  const expireSoon = (): Promise<unknown> =>
    ShopModel.updateOne({ shopDomain: SHOP }, { $set: { 'offlineToken.accessTokenExpiresAt': new Date(Date.now() + 60_000) } });
  const refreshGrants = () => e2e.stub.state.calls.filter((call) => call.kind === 'token' && call.grant === 'refresh_token');
  const lastToken = (): string | undefined => e2e.stub.state.calls.filter((call) => call.kind === 'graphql').at(-1)?.token;

  it('refreshes once behind the lock when requests race, and stores the rotated tokens', async () => {
    client = await login(e2e, SHOP);
    const before = defined(await ShopModel.findOne({ shopDomain: SHOP }).lean());
    expect(refreshGrants()).toHaveLength(0);

    await expireSoon();
    const responses = await Promise.all([1, 2, 3].map(() => client.get('/api/v1/products?limit=1')));
    expect(responses.map((res) => res.status)).toEqual([200, 200, 200]);
    responses.forEach((res) => expect(productListResponseSchema.parse(res.body).items).toHaveLength(1));

    expect(refreshGrants().map((call) => (call.kind === 'token' ? call.status : 0))).toEqual([200]);
    const after = defined(await ShopModel.findOne({ shopDomain: SHOP }).lean());
    expect(after.offlineToken?.accessTokenEnc).not.toBe(before.offlineToken?.accessTokenEnc);
    expect(after.offlineToken?.refreshTokenEnc).not.toBe(before.offlineToken?.refreshTokenEnc);
    expect(after.offlineToken?.refreshLockUntil ?? null).toBeNull();
    expect((after.offlineToken?.accessTokenExpiresAt?.getTime() ?? 0) - Date.now()).toBeGreaterThan(3_000_000);
    expect(e2e.stub.shop(SHOP).offlineTokens.has(defined(lastToken()))).toBe(true);

    // The second rotation only works if the rotated refresh token was the one stored.
    const stale = lastToken();
    await expireSoon();
    expect((await client.get('/api/v1/products?limit=1')).status).toBe(200);
    expect(refreshGrants()).toHaveLength(2);
    expect(lastToken()).not.toBe(stale);
  });

  it('asks the merchant to log in again when Shopify rejects the refresh token', async () => {
    await expireSoon();
    e2e.stub.state.knobs.rejectRefresh.add(SHOP);
    const rejected = await client.get('/api/v1/products?limit=1');
    expect(rejected.status).toBe(409);
    expect(errorOf(rejected).code).toBe('shop_reauth_required');

    const shop = defined(await ShopModel.findOne({ shopDomain: SHOP }).lean());
    expect(shop.status).toBe('reauth_required');
    expect(shop.offlineToken).toBeUndefined();
    // Every API call and the app token refresh now tell the app to start over.
    expect((await client.get('/api/v1/me')).status).toBe(409);
    expect(errorOf(await refresh(client.session.refreshToken)).code).toBe('shop_reauth_required');

    // The next login runs the offline phase again and brings the shop back.
    e2e.stub.state.knobs.rejectRefresh.delete(SHOP);
    const flow = await browserFlow(e2e, SHOP);
    expect(flow.locations).toHaveLength(3);
    const session = authSessionResponseSchema.parse((await exchangeRequest(e2e, flow)).body);
    client = apiClient(e2e, session);
    expect((await ShopModel.findOne({ shopDomain: SHOP }).lean())?.status).toBe('active');
    expect(meResponseSchema.parse((await client.get('/api/v1/me')).body).shop.domain).toBe(SHOP);
    expect((await client.get('/api/v1/products?limit=1')).status).toBe(200);
  });

  it('stays quiet in the logs apart from the expected security warnings', () => {
    const expected = [
      'refresh token reuse detected, session family revoked',
      'refresh token rotated concurrently, session family revoked',
      'shop requires re-authorization',
      'login code presented with a wrong PKCE verifier',
    ];
    expect(e2e.problems(expected)).toEqual([]);
  });
});
