import { z } from 'zod';
import { SESSION_PLATFORMS } from '../enums';
import { shopDomainSchema } from '../shop-domain';
import { isoDateTimeSchema, objectIdSchema } from './common';

// PKCE S256 (SPEC 8.3): the challenge is a 43-char base64url SHA-256, the verifier 43 to 128 unreserved chars.
export const pkceChallengeSchema = z.string().regex(/^[A-Za-z0-9_-]{43}$/, 'Expected an S256 challenge');
export const pkceVerifierSchema = z.string().regex(/^[A-Za-z0-9\-._~]{43,128}$/, 'Expected a PKCE verifier');

// GET /auth/shopify/start
export const shopifyStartQuerySchema = z.object({
  shop: shopDomainSchema,
  challenge: pkceChallengeSchema,
});

// GET /auth/shopify/callback. Shopify may add parameters; all of them take part in the HMAC.
export const shopifyCallbackQuerySchema = z.looseObject({
  code: z.string().min(1),
  hmac: z.string().min(1),
  shop: shopDomainSchema,
  state: z.string().min(1),
  timestamp: z.string().min(1),
  host: z.string().optional(),
});

// GET / (app URL landing page)
export const shopifyLandingQuerySchema = z.looseObject({
  shop: shopDomainSchema,
  hmac: z.string().min(1),
  timestamp: z.string().min(1),
  host: z.string().optional(),
});

export const userSchema = z.object({
  id: objectIdSchema,
  email: z.string().nullable(),
  firstName: z.string().nullable(),
  lastName: z.string().nullable(),
});

// name falls back to the domain when Shopify returned none.
export const shopSchema = z.object({
  id: objectIdSchema,
  domain: shopDomainSchema,
  name: z.string(),
});

// POST /api/v1/auth/exchange
export const authExchangeRequestSchema = z.object({
  code: z.string().min(1).max(256),
  codeVerifier: pkceVerifierSchema,
  platform: z.enum(SESSION_PLATFORMS),
  deviceName: z.string().trim().min(1).max(100).optional(),
});

// POST /api/v1/auth/refresh and POST /api/v1/auth/logout
export const authRefreshRequestSchema = z.object({
  refreshToken: z.string().min(1).max(512),
});
export const authLogoutRequestSchema = authRefreshRequestSchema;

// Response of exchange and refresh.
export const authSessionResponseSchema = z.object({
  accessToken: z.string().min(1),
  accessTokenExpiresAt: isoDateTimeSchema,
  refreshToken: z.string().min(1),
  user: userSchema,
  shop: shopSchema,
});

// App JWT access token claims (SPEC 15): HS256, 15 minutes.
export const accessTokenClaimsSchema = z.object({
  sub: objectIdSchema,
  shopId: objectIdSchema,
  shopDomain: shopDomainSchema,
  typ: z.literal('access'),
  iat: z.number().int().optional(),
  exp: z.number().int(),
});

export type ShopifyStartQuery = z.infer<typeof shopifyStartQuerySchema>;
export type ShopifyCallbackQuery = z.infer<typeof shopifyCallbackQuerySchema>;
export type ShopifyLandingQuery = z.infer<typeof shopifyLandingQuerySchema>;
export type User = z.infer<typeof userSchema>;
export type Shop = z.infer<typeof shopSchema>;
export type AuthExchangeRequest = z.infer<typeof authExchangeRequestSchema>;
export type AuthRefreshRequest = z.infer<typeof authRefreshRequestSchema>;
export type AuthLogoutRequest = z.infer<typeof authLogoutRequestSchema>;
export type AuthSessionResponse = z.infer<typeof authSessionResponseSchema>;
export type AccessTokenClaims = z.infer<typeof accessTokenClaimsSchema>;
