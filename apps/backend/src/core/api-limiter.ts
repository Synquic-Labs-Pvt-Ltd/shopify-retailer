import type { Request, RequestHandler } from 'express';
import { ipKeyGenerator, rateLimit } from 'express-rate-limit';
import { AppError } from './errors';

// Resolves the identity a request is throttled under, or null when there is none to trust.
// It must only return keys that come from a verified credential (see AuthService.rateLimitKey).
export type RateLimitKeyResolver = (req: Request) => Promise<string | null>;

// SPEC 18: 300 requests per minute per user on the API routes. The limiter runs before requireAuth, so the key
// comes from the signature-verified bearer token and names the user, not the token: Shopify session tokens change
// every minute. Requests without a verifiable credential share the budget of their client IP.
export function createApiLimiter(resolveKey: RateLimitKeyResolver, limitPerMinute = 300): RequestHandler {
  return rateLimit({
    windowMs: 60_000,
    limit: limitPerMinute,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    keyGenerator: async (req) => {
      const key = await resolveKey(req).catch(() => null);
      return key ?? `ip:${ipKeyGenerator(req.ip ?? '')}`;
    },
    handler: (_req, _res, next) => next(new AppError('too_many_requests', 'Too many requests, try again in a minute')),
  });
}
