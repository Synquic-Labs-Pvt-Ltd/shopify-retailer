import { decodeJwt, errors as joseErrors, jwtVerify } from 'jose';
import { z } from 'zod';
import { isValidShopDomain } from '@rs/shared';
import { AppError } from '../../core/errors';

// Shopify App Bridge session token (the "ID token" of the embedded app): a JWT signed HS256 with the app's client
// secret that lives one minute. Claims: iss, dest, aud, sub, exp, nbf, iat, jti, sid.
// It is not one of our access tokens (those are signed with JWT_SECRET and carry typ "access").

export const DEFAULT_CLOCK_SKEW_SECONDS = 5;

export interface ShopifySessionClaims {
  // The shop the token was minted for, taken from dest (always a *.myshopify.com host).
  shopDomain: string;
  // sub: the Shopify staff user id, the same id as associated_user.id of an online OAuth token.
  shopifyUserId: string;
  // sid: the Shopify admin session id (null if a token ever omits it).
  sessionId: string | null;
  expiresAt: Date;
}

export interface SessionTokenOptions {
  // The app's client id (SHOPIFY_API_KEY): the token's aud.
  apiKey: string;
  // The app's client secret (SHOPIFY_API_SECRET): the HS256 key.
  apiSecret: string;
  now?: () => Date;
  // Tolerated clock difference for exp and nbf. Default 5 seconds.
  skewSeconds?: number;
}

// Why a token was refused. Only for logs and tests: the client always sees the same generic 401.
export type SessionTokenFailure =
  | 'malformed'
  | 'signature'
  | 'algorithm'
  | 'expired'
  | 'not_yet_valid'
  | 'audience'
  | 'missing_claim'
  | 'invalid_claim'
  | 'host_mismatch'
  | 'invalid_shop';

export class SessionTokenError extends AppError {
  readonly reason: SessionTokenFailure;

  constructor(reason: SessionTokenFailure, cause?: unknown) {
    super('unauthorized', 'Invalid or expired session token', { cause });
    this.name = 'SessionTokenError';
    this.reason = reason;
  }
}

const claimsSchema = z.object({
  iss: z.string().min(1),
  dest: z.string().min(1),
  sub: z.union([z.string().min(1).max(128), z.number().int().nonnegative()]).transform(String),
  sid: z.string().min(1).max(256).optional(),
  exp: z.number().int(),
});

// Our access tokens never carry dest, Shopify session tokens always do. Used only to choose which verifier to run:
// both verifiers check the signature with their own key, so this peek grants nothing.
export function looksLikeSessionToken(token: string): boolean {
  try {
    return typeof decodeJwt(token).dest === 'string';
  } catch {
    return false;
  }
}

function shopHost(value: string): string | null {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' || url.port !== '' || url.username !== '' || url.password !== '') return null;
  return url.hostname;
}

function failureOf(err: unknown): SessionTokenFailure {
  if (err instanceof joseErrors.JOSEAlgNotAllowed) return 'algorithm';
  if (err instanceof joseErrors.JWSSignatureVerificationFailed) return 'signature';
  if (err instanceof joseErrors.JWTExpired) return 'expired';
  if (err instanceof joseErrors.JWTClaimValidationFailed) {
    if (err.reason === 'missing') return 'missing_claim';
    if (err.reason === 'invalid') return 'invalid_claim';
    if (err.claim === 'nbf') return 'not_yet_valid';
    return err.claim === 'aud' ? 'audience' : 'invalid_claim';
  }
  return 'malformed';
}

// Verifies a Shopify session token and returns who it is for. Throws SessionTokenError (an AppError unauthorized)
// unless: the signature is valid HS256 under the client secret (no other algorithm, never "none"); exp is in the
// future and nbf in the past (within the skew); aud is the app's client id; iss and dest are https URLs whose
// hostnames match and are a *.myshopify.com shop; sub is present. jose compares the signature in constant time.
export async function verifyShopifySessionToken(token: string, options: SessionTokenOptions): Promise<ShopifySessionClaims> {
  const now = options.now ?? (() => new Date());
  let payload: unknown;
  try {
    ({ payload } = await jwtVerify(token, new TextEncoder().encode(options.apiSecret), {
      algorithms: ['HS256'],
      audience: options.apiKey,
      currentDate: now(),
      clockTolerance: options.skewSeconds ?? DEFAULT_CLOCK_SKEW_SECONDS,
      requiredClaims: ['iss', 'dest', 'sub', 'aud', 'exp', 'nbf'],
    }));
  } catch (err) {
    throw new SessionTokenError(failureOf(err), err);
  }

  const claims = claimsSchema.safeParse(payload);
  if (!claims.success) throw new SessionTokenError('invalid_claim', claims.error);

  const issuerHost = shopHost(claims.data.iss);
  const destHost = shopHost(claims.data.dest);
  if (issuerHost === null || destHost === null || issuerHost !== destHost) throw new SessionTokenError('host_mismatch');
  if (!isValidShopDomain(destHost)) throw new SessionTokenError('invalid_shop');

  return {
    shopDomain: destHost,
    shopifyUserId: claims.data.sub,
    sessionId: claims.data.sid ?? null,
    expiresAt: new Date(claims.data.exp * 1000),
  };
}
