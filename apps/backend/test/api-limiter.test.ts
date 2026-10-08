import express from 'express';
import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';
import { errorEnvelopeSchema } from '@rs/shared';
import { createApiLimiter, type RateLimitKeyResolver } from '../src/core/api-limiter';
import { createErrorHandler } from '../src/core/errors';
import { createLogger } from '../src/core/logger';

function buildApp(limit: number, resolveKey: RateLimitKeyResolver): express.Express {
  const app = express();
  app.set('trust proxy', 1);
  app.use(createApiLimiter(resolveKey, limit));
  app.get('/ping', (_req, res) => {
    res.json({ ok: true });
  });
  app.use(createErrorHandler(createLogger('silent')));
  return app;
}

// A resolver that trusts the header, like a verified token would: "Bearer user-a" is user a.
const byHeader: RateLimitKeyResolver = (req) => {
  const match = /^Bearer (user-\w+)$/.exec(req.header('authorization') ?? '');
  return Promise.resolve(match?.[1] === undefined ? null : `user:${match[1]}`);
};

describe('createApiLimiter', () => {
  it('returns 429 too_many_requests after the limit, per resolved key', async () => {
    const app = buildApp(2, byHeader);
    const a = { authorization: 'Bearer user-a' };
    expect((await request(app).get('/ping').set(a)).status).toBe(200);
    expect((await request(app).get('/ping').set(a)).status).toBe(200);
    const limited = await request(app).get('/ping').set(a);
    expect(limited.status).toBe(429);
    expect(errorEnvelopeSchema.parse(limited.body).error.code).toBe('too_many_requests');

    // A different user is not affected.
    expect((await request(app).get('/ping').set({ authorization: 'Bearer user-b' })).status).toBe(200);
  });

  it('keys on what the resolver returns, not on the header text', async () => {
    // The resolver maps any header to one user, like two different session tokens of the same person.
    const app = buildApp(2, () => Promise.resolve('shop:demo:42'));
    expect((await request(app).get('/ping').set({ authorization: 'Bearer first-token' })).status).toBe(200);
    expect((await request(app).get('/ping').set({ authorization: 'Bearer second-token' })).status).toBe(200);
    expect((await request(app).get('/ping').set({ authorization: 'Bearer third-token' })).status).toBe(429);
  });

  it('falls back to the client IP without a token or when the resolver has no key', async () => {
    const app = buildApp(1, byHeader);
    expect((await request(app).get('/ping')).status).toBe(200);
    expect((await request(app).get('/ping')).status).toBe(429);
    // An unverifiable token shares the budget of its IP, whatever it says.
    expect((await request(app).get('/ping').set({ authorization: 'Bearer anything-else' })).status).toBe(429);
    // Another IP has its own budget.
    expect((await request(app).get('/ping').set('x-forwarded-for', '198.51.100.7')).status).toBe(200);
    // A verified user is not charged to the IP budget.
    expect((await request(app).get('/ping').set({ authorization: 'Bearer user-a' })).status).toBe(200);
  });

  it('falls back to the client IP when the resolver throws', async () => {
    const resolver = vi.fn<RateLimitKeyResolver>(() => Promise.reject(new Error('boom')));
    const app = buildApp(1, resolver);
    expect((await request(app).get('/ping')).status).toBe(200);
    expect((await request(app).get('/ping')).status).toBe(429);
    expect(resolver).toHaveBeenCalledTimes(2);
  });
});
