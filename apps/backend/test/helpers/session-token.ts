import { createHmac, randomUUID } from 'node:crypto';
import { jwtVerify } from 'jose';

// Mints the tokens Shopify App Bridge hands to an embedded app: HS256 under the app's client secret, one minute,
// claims iss, dest, aud, sub, exp, nbf, iat, jti, sid. Independent of the implementation under test.

export const EXCHANGE_GRANT = 'urn:ietf:params:oauth:grant-type:token-exchange';
export const ID_TOKEN_TYPE = 'urn:ietf:params:oauth:token-type:id_token';
export const OFFLINE_TOKEN_TYPE = 'urn:shopify:params:oauth:token-type:offline-access-token';

export interface SessionTokenSpec {
  shop: string;
  apiKey: string;
  apiSecret: string;
  // Shopify staff user id (the sub claim). Default 902541635, the id the OAuth fake uses for its user.
  sub?: string | number;
  // Issue time in ms. Default: now.
  at?: number;
  // Lifetime in seconds. Default 60.
  ttlSeconds?: number;
  // Claims replaced or added after the defaults.
  claims?: Record<string, unknown>;
  // Claims removed after everything else.
  omit?: string[];
  // Header algorithm. Default HS256. 'none' builds an unsigned token.
  alg?: 'HS256' | 'HS384' | 'HS512' | 'none';
  // Key used to sign. Default apiSecret.
  secret?: string;
}

export const DEFAULT_SHOPIFY_USER_ID = 902541635;

export function sessionClaims(spec: SessionTokenSpec): Record<string, unknown> {
  const iat = Math.floor((spec.at ?? Date.now()) / 1000);
  const claims: Record<string, unknown> = {
    iss: `https://${spec.shop}/admin`,
    dest: `https://${spec.shop}`,
    aud: spec.apiKey,
    sub: String(spec.sub ?? DEFAULT_SHOPIFY_USER_ID),
    exp: iat + (spec.ttlSeconds ?? 60),
    nbf: iat,
    iat,
    jti: randomUUID(),
    sid: randomUUID(),
    ...spec.claims,
  };
  for (const name of spec.omit ?? []) delete claims[name];
  return claims;
}

const b64 = (value: unknown): string => Buffer.from(JSON.stringify(value)).toString('base64url');

const HMAC_ALGORITHMS = { HS256: 'sha256', HS384: 'sha384', HS512: 'sha512' } as const;

// Signs with node:crypto, not jose, so the token comes from an implementation independent of the verifier under test.
export function signSessionTokenSync(spec: SessionTokenSpec): string {
  const alg = spec.alg ?? 'HS256';
  const body = `${b64({ alg, typ: 'JWT' })}.${b64(sessionClaims(spec))}`;
  if (alg === 'none') return `${body}.`;
  return `${body}.${createHmac(HMAC_ALGORITHMS[alg], spec.secret ?? spec.apiSecret).update(body).digest('base64url')}`;
}

export const signSessionToken = (spec: SessionTokenSpec): Promise<string> => Promise.resolve(signSessionTokenSync(spec));

// What Shopify's token endpoint checks on a token exchange request. Returns null when the request is acceptable,
// otherwise a short reason (the fake answers 400 invalid_request).
export async function checkExchangeRequest(
  form: Record<string, string>,
  expected: { shop: string; apiKey: string; apiSecret: string; now?: () => Date },
): Promise<string | null> {
  if (form.client_id !== expected.apiKey || form.client_secret !== expected.apiSecret) return 'invalid_client';
  if (form.grant_type !== EXCHANGE_GRANT) return 'wrong grant_type';
  if (form.subject_token_type !== ID_TOKEN_TYPE) return 'wrong subject_token_type';
  if (form.requested_token_type !== OFFLINE_TOKEN_TYPE) return 'wrong requested_token_type';
  if (form.expiring !== '1') return 'expiring must be 1';
  if (form.subject_token === undefined) return 'missing subject_token';
  try {
    const { payload } = await jwtVerify(form.subject_token, new TextEncoder().encode(expected.apiSecret), {
      algorithms: ['HS256'],
      audience: expected.apiKey,
      currentDate: expected.now?.() ?? new Date(),
    });
    return new URL(String(payload.dest)).hostname === expected.shop ? null : 'dest does not match the shop';
  } catch {
    return 'invalid subject_token';
  }
}
