import { createHash } from 'node:crypto';
import type { RequestHandler } from 'express';
import { ipKeyGenerator, rateLimit } from 'express-rate-limit';
import { AppError } from './errors';

// SPEC 18: 300 requests per minute per user on the API routes. The limiter runs before requireAuth,
// so the key is a fingerprint of the bearer token (one user session), falling back to the client IP.
export function createApiLimiter(limitPerMinute = 300): RequestHandler {
  return rateLimit({
    windowMs: 60_000,
    limit: limitPerMinute,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    keyGenerator: (req) => {
      const authorization = req.header('authorization');
      if (authorization !== undefined) {
        return `token:${createHash('sha256').update(authorization).digest('hex').slice(0, 16)}`;
      }
      return `ip:${ipKeyGenerator(req.ip ?? '')}`;
    },
    handler: (_req, _res, next) => next(new AppError('too_many_requests', 'Too many requests, try again in a minute')),
  });
}
