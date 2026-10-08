import { SignJWT } from 'jose';
import { describe, expect, it } from 'vitest';
import { AppError } from '../../src/core/errors';
import {
  DEFAULT_CLOCK_SKEW_SECONDS,
  SessionTokenError,
  looksLikeSessionToken,
  verifyShopifySessionToken,
  type SessionTokenFailure,
} from '../../src/modules/auth/session-token';
import { signSessionToken, type SessionTokenSpec } from '../helpers/session-token';

const API_KEY = 'client-id-0123';
const API_SECRET = 'client-secret-0123456789abcdef0123';
const SHOP = 'demo-store.myshopify.com';
// A fixed clock, so every edge is exact.
const NOW = Date.parse('2026-10-08T12:00:00.000Z');
const nowSeconds = NOW / 1000;

const verify = (token: string, extra: { skewSeconds?: number; now?: number } = {}) =>
  verifyShopifySessionToken(token, {
    apiKey: API_KEY,
    apiSecret: API_SECRET,
    now: () => new Date(extra.now ?? NOW),
    ...(extra.skewSeconds === undefined ? {} : { skewSeconds: extra.skewSeconds }),
  });

const mint = (spec: Partial<SessionTokenSpec> = {}): Promise<string> =>
  signSessionToken({ shop: SHOP, apiKey: API_KEY, apiSecret: API_SECRET, at: NOW, ...spec });

async function failureOf(token: string, extra?: Parameters<typeof verify>[1]): Promise<SessionTokenFailure> {
  const err: unknown = await verify(token, extra).then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(SessionTokenError);
  expect(err).toBeInstanceOf(AppError);
  // The client never learns why: one generic 401.
  expect(err).toMatchObject({ code: 'unauthorized', status: 401, message: 'Invalid or expired session token' });
  return (err as SessionTokenError).reason;
}

const b64 = (value: unknown): string => Buffer.from(JSON.stringify(value)).toString('base64url');

describe('verifyShopifySessionToken: accepted tokens', () => {
  it('returns the shop, the staff user, the session id and the expiry of a valid token', async () => {
    const token = await mint({ sub: 902541635, claims: { sid: 'session-1' } });
    await expect(verify(token)).resolves.toEqual({
      shopDomain: SHOP,
      shopifyUserId: '902541635',
      sessionId: 'session-1',
      expiresAt: new Date(NOW + 60_000),
    });
  });

  it('takes the shop from dest and lowercases the host', async () => {
    const claims = { dest: 'https://Demo-Store.myshopify.com', iss: 'https://Demo-Store.myshopify.com/admin' };
    expect((await verify(await mint({ claims }))).shopDomain).toBe(SHOP);
  });

  it('accepts a numeric sub and tokens without sid, jti or iat', async () => {
    const claims = await verify(await mint({ claims: { sub: 42 }, omit: ['sid', 'jti', 'iat'] }));
    expect(claims).toMatchObject({ shopifyUserId: '42', sessionId: null });
  });

  it('accepts an audience list that contains the client id', async () => {
    await expect(verify(await mint({ claims: { aud: ['other', API_KEY] } }))).resolves.toMatchObject({ shopDomain: SHOP });
  });
});

describe('verifyShopifySessionToken: signature and algorithm', () => {
  it('rejects a token signed with another secret', async () => {
    expect(await failureOf(await mint({ secret: 'another-secret-another-secret-12345' }))).toBe('signature');
  });

  it('rejects a token whose payload was changed after signing', async () => {
    const [header, , signature] = (await mint()).split('.');
    const forged = b64({ iss: `https://other.myshopify.com/admin`, dest: 'https://other.myshopify.com', aud: API_KEY, sub: '1', exp: nowSeconds + 60, nbf: nowSeconds });
    expect(await failureOf(`${header}.${forged}.${signature}`)).toBe('signature');
  });

  it.each(['HS384', 'HS512'] as const)('rejects %s even when it is signed with the right secret', async (alg) => {
    expect(await failureOf(await mint({ alg }))).toBe('algorithm');
  });

  it('rejects an unsigned token (alg none), with or without a signature part', async () => {
    expect(await failureOf(await mint({ alg: 'none' }))).toBe('algorithm');
    const claims = { iss: `https://${SHOP}/admin`, dest: `https://${SHOP}`, aud: API_KEY, sub: '1', exp: nowSeconds + 60, nbf: nowSeconds };
    expect(await failureOf(`${b64({ alg: 'none' })}.${b64(claims)}.garbage`)).toBe('algorithm');
    expect(await failureOf(`${b64({ alg: 'None', typ: 'JWT' })}.${b64(claims)}.`)).toBe('algorithm');
    expect(await failureOf(`${b64({ alg: 'NONE', typ: 'JWT' })}.${b64(claims)}.`)).toBe('algorithm');
  });

  it('rejects an asymmetric algorithm header (key confusion)', async () => {
    const claims = { iss: `https://${SHOP}/admin`, dest: `https://${SHOP}`, aud: API_KEY, sub: '1', exp: nowSeconds + 60, nbf: nowSeconds };
    for (const alg of ['RS256', 'ES256', 'PS256', 'EdDSA']) {
      expect(await failureOf(`${b64({ alg, typ: 'JWT' })}.${b64(claims)}.c2ln`)).toBe('algorithm');
    }
  });

  it('rejects one of our own access tokens (signed with JWT_SECRET)', async () => {
    const own = await new SignJWT({ shopId: 'a'.repeat(24), shopDomain: SHOP, typ: 'access' })
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject('b'.repeat(24))
      .setIssuedAt(nowSeconds)
      .setExpirationTime(nowSeconds + 900)
      .sign(new TextEncoder().encode('dev-only-jwt-secret-do-not-use-in-production-0000'));
    expect(await failureOf(own)).toBe('signature');
  });

  it.each(['', 'garbage', 'a.b.c', 'a.b', '....', `${'x'.repeat(40)}.${'y'.repeat(40)}.${'z'.repeat(40)}`])('rejects malformed input %j', async (token) => {
    expect(await failureOf(token)).toBe('malformed');
  });
});

describe('verifyShopifySessionToken: time claims', () => {
  it('rejects an expired token', async () => {
    expect(await failureOf(await mint({ at: NOW - 120_000 }))).toBe('expired');
    expect(await failureOf(await mint({ at: NOW - 24 * 3_600_000 }))).toBe('expired');
  });

  it('lives one minute from issue, plus the skew', async () => {
    const token = await mint();
    await expect(verify(token, { now: NOW + 59_000 })).resolves.toMatchObject({ shopDomain: SHOP });
    expect(await failureOf(token, { now: NOW + 60_000 + DEFAULT_CLOCK_SKEW_SECONDS * 1000 })).toBe('expired');
  });

  it('has a clock skew of 5 seconds for exp: expired 4 seconds ago passes, 5 seconds ago does not', async () => {
    expect(DEFAULT_CLOCK_SKEW_SECONDS).toBe(5);
    await expect(verify(await mint({ claims: { exp: nowSeconds - 4 } }))).resolves.toMatchObject({ shopDomain: SHOP });
    expect(await failureOf(await mint({ claims: { exp: nowSeconds - 5 } }))).toBe('expired');
    expect(await failureOf(await mint({ claims: { exp: nowSeconds } }), { skewSeconds: 0 })).toBe('expired');
  });

  it('has a clock skew of 5 seconds for nbf: valid in 5 seconds passes, in 6 seconds does not', async () => {
    await expect(verify(await mint({ claims: { nbf: nowSeconds + 5 } }))).resolves.toMatchObject({ shopDomain: SHOP });
    expect(await failureOf(await mint({ claims: { nbf: nowSeconds + 6 } }))).toBe('not_yet_valid');
    expect(await failureOf(await mint({ claims: { nbf: nowSeconds + 1 } }), { skewSeconds: 0 })).toBe('not_yet_valid');
    await expect(verify(await mint({ claims: { nbf: nowSeconds } }), { skewSeconds: 0 })).resolves.toMatchObject({ shopDomain: SHOP });
  });

  it('honours a custom skew', async () => {
    const token = await mint({ claims: { exp: nowSeconds - 20 } });
    expect(await failureOf(token)).toBe('expired');
    await expect(verify(token, { skewSeconds: 30 })).resolves.toMatchObject({ shopDomain: SHOP });
  });

  it('rejects non-numeric time claims', async () => {
    expect(await failureOf(await mint({ claims: { exp: 'tomorrow' } }))).toBe('invalid_claim');
    expect(await failureOf(await mint({ claims: { nbf: '0' } }))).toBe('invalid_claim');
  });
});

describe('verifyShopifySessionToken: audience, hosts and required claims', () => {
  it('rejects a token minted for another app', async () => {
    expect(await failureOf(await mint({ claims: { aud: 'someone-elses-client-id' } }))).toBe('audience');
    expect(await failureOf(await mint({ claims: { aud: ['one', 'two'] } }))).toBe('audience');
    expect(await failureOf(await mint({ claims: { aud: '' } }))).toBe('audience');
  });

  it('rejects when the hostnames of iss and dest differ', async () => {
    expect(await failureOf(await mint({ claims: { iss: 'https://other-store.myshopify.com/admin' } }))).toBe('host_mismatch');
  });

  it.each([
    ['evil.example.com', 'a host outside myshopify.com'],
    ['demo-store.myshopify.com.evil.com', 'a myshopify.com look-alike'],
    ['evilmyshopify.com', 'a bare look-alike'],
    ['admin.shopify.com', 'the Shopify admin host'],
    ['myshopify.com', 'the apex'],
    ['-bad.myshopify.com', 'an invalid shop name'],
  ])('rejects dest %s (%s)', async (host) => {
    const claims = { dest: `https://${host}`, iss: `https://${host}/admin` };
    expect(await failureOf(await mint({ claims }))).toBe('invalid_shop');
  });

  it.each([
    ['http://demo-store.myshopify.com', 'plain http'],
    ['https://demo-store.myshopify.com:8443', 'a port'],
    ['https://user:pass@demo-store.myshopify.com', 'credentials'],
    ['https://demo-store.myshopify.com@evil.example.com', 'a userinfo trick'],
    ['demo-store.myshopify.com', 'no scheme'],
    ['not a url', 'garbage'],
  ])('rejects dest %s (%s)', async (dest) => {
    expect(await failureOf(await mint({ claims: { dest, iss: dest } }))).toBe('host_mismatch');
  });

  it.each(['iss', 'dest', 'sub', 'aud', 'exp', 'nbf'])('rejects a token without %s', async (claim) => {
    expect(await failureOf(await mint({ omit: [claim] }))).toBe('missing_claim');
  });

  it.each([
    ['sub', ''],
    ['sub', { id: 1 }],
    ['sub', -5],
    ['sub', 1.5],
    ['dest', 5],
    ['iss', null],
  ])('rejects %s = %j', async (claim, value) => {
    const reason = await failureOf(await mint({ claims: { [claim]: value } }));
    expect(['invalid_claim', 'host_mismatch', 'missing_claim']).toContain(reason);
  });

  it('rejects an empty payload', async () => {
    const token = await new SignJWT({}).setProtectedHeader({ alg: 'HS256' }).sign(new TextEncoder().encode(API_SECRET));
    expect(await failureOf(token)).toBe('missing_claim');
  });
});

describe('looksLikeSessionToken', () => {
  it('is true for anything with a dest claim, signed or not, and false for the rest', async () => {
    expect(looksLikeSessionToken(await mint())).toBe(true);
    expect(looksLikeSessionToken(await mint({ secret: 'wrong-secret-wrong-secret-wrong-secret' }))).toBe(true);
    expect(looksLikeSessionToken(await mint({ alg: 'none' }))).toBe(true);

    const own = await new SignJWT({ shopId: 'a', typ: 'access' }).setProtectedHeader({ alg: 'HS256' }).sign(new TextEncoder().encode(API_SECRET));
    expect(looksLikeSessionToken(own)).toBe(false);
    expect(looksLikeSessionToken(await mint({ omit: ['dest'] }))).toBe(false);
    expect(looksLikeSessionToken(await mint({ claims: { dest: 5 } }))).toBe(false);
    for (const garbage of ['', 'garbage', 'a.b.c', 'Bearer x']) expect(looksLikeSessionToken(garbage)).toBe(false);
  });
});
