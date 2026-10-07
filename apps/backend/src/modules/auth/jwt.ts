import { SignJWT, jwtVerify } from 'jose';
import { accessTokenClaimsSchema, type AccessTokenClaims } from '@rs/shared';
import { AppError } from '../../core/errors';

export const ACCESS_TOKEN_TTL_SECONDS = 15 * 60;

export interface AccessTokenSubject {
  userId: string;
  shopId: string;
  shopDomain: string;
}

export interface JwtService {
  sign(subject: AccessTokenSubject): Promise<{ token: string; expiresAt: Date }>;
  // Throws AppError unauthorized for anything that is not a valid, unexpired HS256 access token.
  verify(token: string): Promise<AccessTokenClaims>;
}

// SPEC 15: HS256 with JWT_SECRET, claims sub, shopId, shopDomain, typ "access", 15 minutes.
export function createJwtService(secret: string, now: () => Date): JwtService {
  const key = new TextEncoder().encode(secret);

  return {
    async sign({ userId, shopId, shopDomain }) {
      const issuedAt = Math.floor(now().getTime() / 1000);
      const expiresAt = issuedAt + ACCESS_TOKEN_TTL_SECONDS;
      const token = await new SignJWT({ shopId, shopDomain, typ: 'access' })
        .setProtectedHeader({ alg: 'HS256' })
        .setSubject(userId)
        .setIssuedAt(issuedAt)
        .setExpirationTime(expiresAt)
        .sign(key);
      return { token, expiresAt: new Date(expiresAt * 1000) };
    },

    async verify(token) {
      try {
        const { payload } = await jwtVerify(token, key, { algorithms: ['HS256'], currentDate: now() });
        return accessTokenClaimsSchema.parse(payload);
      } catch {
        throw AppError.unauthorized('Invalid or expired access token');
      }
    },
  };
}
