import request from 'supertest';
import { afterAll, describe, expect, it } from 'vitest';
import { errorEnvelopeSchema, healthResponseSchema } from '@rs/shared';
import { createApp } from '../src/app';
import { createContainer } from '../src/container';
import { createConfigService } from '../src/core/config';
import { parseEnv } from '../src/core/env';
import { createLogger } from '../src/core/logger';

const logger = createLogger('silent');
const config = createConfigService({ logger, watch: false });
const env = parseEnv({});
const app = createApp({ env, logger, config, container: createContainer({ env, logger, config }) });

afterAll(() => config.close());

describe('GET /health', () => {
  it('answers ok with the db disconnected and no worker tick yet', async () => {
    const res = await request(app).get('/health');
    expect(res.status).toBe(200);
    const body = healthResponseSchema.parse(res.body);
    expect(body.ok).toBe(true);
    expect(body.db).toBe('disconnected');
    expect(body.worker.lastTickAt).toBeNull();
    expect(body.pausedLanes).toEqual([]);
    expect(res.headers['x-request-id']).toBeTruthy();
  });
});

describe('error handling', () => {
  it('returns the not_found envelope for unknown routes', async () => {
    const res = await request(app).get('/nope');
    expect(res.status).toBe(404);
    expect(errorEnvelopeSchema.parse(res.body).error.code).toBe('not_found');
  });

  it('returns validation_failed for malformed JSON', async () => {
    const res = await request(app).post('/anything').set('content-type', 'application/json').send('{ broken');
    expect(res.status).toBe(400);
    expect(errorEnvelopeSchema.parse(res.body).error.code).toBe('validation_failed');
  });

  it('mounts the real webhook route on a raw body and rejects an unsigned request', async () => {
    const res = await request(app).post('/webhooks/shopify').set('content-type', 'application/json').send('{"a":1}');
    expect(res.status).toBe(401);
    expect(errorEnvelopeSchema.parse(res.body).error.code).toBe('unauthorized');
  });

  it.each(['/api/v1/me', '/api/v1/products', '/api/v1/media?ids=x', '/api/v1/batches'])('rejects %s without a bearer token', async (path) => {
    const res = await request(app).get(path);
    expect(res.status).toBe(401);
    expect(errorEnvelopeSchema.parse(res.body).error.code).toBe('unauthorized');
  });
});
