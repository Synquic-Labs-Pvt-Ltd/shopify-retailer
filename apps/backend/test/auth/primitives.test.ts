import { SignJWT } from 'jose';
import { describe, expect, it } from 'vitest';
import { isValidShopDomain, normalizeShopDomain } from '@rs/shared';
import { pkceChallengeFor, randomToken, safeEqual, sha256Hex, verifyPkce } from '../../src/modules/auth/crypto';
import { verifyOAuthQueryHmac } from '../../src/modules/auth/hmac';
import { ACCESS_TOKEN_TTL_SECONDS, createJwtService } from '../../src/modules/auth/jwt';
import { parseShopInput } from '../../src/modules/auth/oauth-flow';
import { signQuery, signedQueryString } from '../shopify/fake-shopify';

const SECRET = 'shpss_test_secret';
const BASE = { code: 'abc123', shop: 'demo-store.myshopify.com', state: 'nonce', timestamp: '1760000000', host: 'YWRtaW4' };

describe('OAuth query HMAC', () => {
  it('accepts a correctly signed query regardless of parameter order', () => {
    const query = signedQueryString(BASE, SECRET);
    expect(verifyOAuthQueryHmac(query, SECRET)).toBe(true);

    const reordered = [...new URLSearchParams(query).entries()].reverse();
    expect(verifyOAuthQueryHmac(new URLSearchParams(reordered).toString(), SECRET)).toBe(true);
  });

  it('matches a digest computed outside Node (openssl dgst -sha256 -hmac)', () => {
    // printf 'code=abc123&host=YWRtaW4&shop=demo-store.myshopify.com&state=nonce&timestamp=1760000000' | openssl dgst -sha256 -hmac shpss_test_secret
    const hmac = '66dc654f81e6367cd5de5519bd0488ec4fd0c4e7754c524ea656ef6122ef8b83';
    expect(signQuery(BASE, SECRET)).toBe(hmac);
    expect(verifyOAuthQueryHmac(new URLSearchParams({ ...BASE, hmac }).toString(), SECRET)).toBe(true);
  });

  it('covers extra parameters Shopify adds', () => {
    const query = signedQueryString({ ...BASE, locale: 'en', embedded: '0' }, SECRET);
    expect(verifyOAuthQueryHmac(query, SECRET)).toBe(true);
    expect(verifyOAuthQueryHmac(`${query}&injected=1`, SECRET)).toBe(false);
  });

  it('rejects tampered values, a wrong secret and malformed signatures', () => {
    const query = signedQueryString(BASE, SECRET);
    expect(verifyOAuthQueryHmac(query.replace('abc123', 'abc124'), SECRET)).toBe(false);
    expect(verifyOAuthQueryHmac(query.replace('demo-store', 'evil-store'), SECRET)).toBe(false);
    expect(verifyOAuthQueryHmac(query, 'another-secret')).toBe(false);
    expect(verifyOAuthQueryHmac(new URLSearchParams(BASE).toString(), SECRET)).toBe(false);
    expect(verifyOAuthQueryHmac(`${new URLSearchParams(BASE).toString()}&hmac=deadbeef`, SECRET)).toBe(false);
    expect(verifyOAuthQueryHmac(`${new URLSearchParams(BASE).toString()}&hmac=${'z'.repeat(64)}`, SECRET)).toBe(false);
    expect(verifyOAuthQueryHmac('', SECRET)).toBe(false);
  });
});

describe('PKCE S256', () => {
  it('matches the RFC 7636 appendix B vector', () => {
    const verifier = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk';
    const challenge = 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM';
    expect(pkceChallengeFor(verifier)).toBe(challenge);
    expect(verifyPkce(verifier, challenge)).toBe(true);
  });

  it('rejects a different verifier and a different challenge', () => {
    const verifier = randomToken(32);
    expect(verifyPkce(randomToken(32), pkceChallengeFor(verifier))).toBe(false);
    expect(verifyPkce(verifier, pkceChallengeFor(randomToken(32)))).toBe(false);
    expect(verifyPkce(verifier, '')).toBe(false);
  });
});

describe('helpers', () => {
  it('sha256Hex is stable and safeEqual compares lengths first', () => {
    expect(sha256Hex('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
    expect(safeEqual('abc', 'abc')).toBe(true);
    expect(safeEqual('abc', 'abd')).toBe(false);
    expect(safeEqual('abc', 'abcd')).toBe(false);
  });

  it('randomToken is URL safe and unique', () => {
    const a = randomToken(32);
    expect(a).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(randomToken(32)).not.toBe(a);
  });
});

describe('shop hostname validation', () => {
  it('normalizes bare names and accepts valid myshopify domains', () => {
    expect(parseShopInput('Demo-Store')).toBe('demo-store.myshopify.com');
    expect(parseShopInput(' demo-store.myshopify.com ')).toBe('demo-store.myshopify.com');
    expect(normalizeShopDomain('a1')).toBe('a1.myshopify.com');
  });

  it.each([
    'evil.com',
    'demo.myshopify.com.evil.com',
    'demo.myshopify.com/evil',
    'demo.myshopify.com@evil.com',
    'demo.myshopify.com#x',
    'a.b.myshopify.com',
    '-demo',
    'demo store',
    '',
    'demo\\evil',
  ])('rejects %j', (input) => {
    expect(isValidShopDomain(normalizeShopDomain(input))).toBe(false);
    expect(() => parseShopInput(input)).toThrow(expect.objectContaining({ code: 'validation_failed' }));
  });
});

describe('access JWT', () => {
  const NOW = new Date('2026-10-07T12:00:00.000Z');
  const subject = { userId: 'a'.repeat(24), shopId: 'b'.repeat(24), shopDomain: 'demo-store.myshopify.com' };
  const secret = 'j'.repeat(40);
  const jwt = createJwtService(secret, () => NOW);

  it('signs HS256 tokens that expire after 15 minutes', async () => {
    const { token, expiresAt } = await jwt.sign(subject);
    expect(expiresAt.getTime() - NOW.getTime()).toBe(ACCESS_TOKEN_TTL_SECONDS * 1000);
    expect(ACCESS_TOKEN_TTL_SECONDS).toBe(900);

    const [header, payload] = token.split('.').slice(0, 2).map((part) => JSON.parse(Buffer.from(part ?? '', 'base64url').toString('utf8')) as Record<string, unknown>);
    expect(header).toMatchObject({ alg: 'HS256' });
    expect(payload).toMatchObject({ sub: subject.userId, shopId: subject.shopId, shopDomain: subject.shopDomain, typ: 'access' });

    await expect(jwt.verify(token)).resolves.toMatchObject({ sub: subject.userId, typ: 'access' });
  });

  it('rejects an expired token', async () => {
    const { token } = await jwt.sign(subject);
    const later = createJwtService(secret, () => new Date(NOW.getTime() + 15 * 60_000 + 1000));
    await expect(later.verify(token)).rejects.toMatchObject({ code: 'unauthorized' });
    const justBefore = createJwtService(secret, () => new Date(NOW.getTime() + 14 * 60_000));
    await expect(justBefore.verify(token)).resolves.toBeTruthy();
  });

  it('rejects other secrets, other algorithms, unsigned tokens and wrong token types', async () => {
    const { token } = await jwt.sign(subject);
    await expect(createJwtService('x'.repeat(40), () => NOW).verify(token)).rejects.toMatchObject({ code: 'unauthorized' });
    await expect(jwt.verify(`${token}x`)).rejects.toMatchObject({ code: 'unauthorized' });
    await expect(jwt.verify('garbage')).rejects.toMatchObject({ code: 'unauthorized' });

    const key = new TextEncoder().encode(secret);
    const exp = Math.floor(NOW.getTime() / 1000) + 600;
    const hs384 = await new SignJWT({ shopId: subject.shopId, shopDomain: subject.shopDomain, typ: 'access' })
      .setProtectedHeader({ alg: 'HS384' }).setSubject(subject.userId).setExpirationTime(exp).sign(key);
    await expect(jwt.verify(hs384)).rejects.toMatchObject({ code: 'unauthorized' });

    const unsigned = [
      Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url'),
      Buffer.from(JSON.stringify({ sub: subject.userId, shopId: subject.shopId, shopDomain: subject.shopDomain, typ: 'access', exp })).toString('base64url'),
      '',
    ].join('.');
    await expect(jwt.verify(unsigned)).rejects.toMatchObject({ code: 'unauthorized' });

    const refreshTyped = await new SignJWT({ shopId: subject.shopId, shopDomain: subject.shopDomain, typ: 'refresh' })
      .setProtectedHeader({ alg: 'HS256' }).setSubject(subject.userId).setExpirationTime(exp).sign(key);
    await expect(jwt.verify(refreshTyped)).rejects.toMatchObject({ code: 'unauthorized' });
  });
});
