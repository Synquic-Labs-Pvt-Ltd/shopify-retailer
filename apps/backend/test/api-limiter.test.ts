import express from 'express';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { errorEnvelopeSchema } from '@rs/shared';
import { createApiLimiter } from '../src/core/api-limiter';
import { createErrorHandler } from '../src/core/errors';
import { createLogger } from '../src/core/logger';

function buildApp(limit: number): express.Express {
  const app = express();
  app.use(createApiLimiter(limit));
  app.get('/ping', (_req, res) => {
    res.json({ ok: true });
  });
  app.use(createErrorHandler(createLogger('silent')));
  return app;
}

describe('createApiLimiter', () => {
  it('returns 429 too_many_requests after the limit, per bearer token', async () => {
    const app = buildApp(2);
    const a = { authorization: 'Bearer token-a' };
    expect((await request(app).get('/ping').set(a)).status).toBe(200);
    expect((await request(app).get('/ping').set(a)).status).toBe(200);
    const limited = await request(app).get('/ping').set(a);
    expect(limited.status).toBe(429);
    expect(errorEnvelopeSchema.parse(limited.body).error.code).toBe('too_many_requests');

    // A different user is not affected.
    expect((await request(app).get('/ping').set({ authorization: 'Bearer token-b' })).status).toBe(200);
  });

  it('falls back to the client IP without a token', async () => {
    const app = buildApp(1);
    expect((await request(app).get('/ping')).status).toBe(200);
    expect((await request(app).get('/ping')).status).toBe(429);
  });
});
