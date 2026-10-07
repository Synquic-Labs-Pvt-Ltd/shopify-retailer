import request from 'supertest';
import { afterAll, describe, expect, it } from 'vitest';
import { errorEnvelopeSchema, healthResponseSchema } from '@rs/shared';
import { createApp } from '../src/app';
import { createConfigService } from '../src/core/config';
import { parseEnv } from '../src/core/env';
import { createLogger } from '../src/core/logger';
import { createWorkerState } from '../src/core/worker';

const logger = createLogger('silent');
const config = createConfigService({ logger, watch: false });
const workerState = createWorkerState();
const app = createApp({ env: parseEnv({}), logger, config, workerState });

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

  it('reports the worker lastTickAt', async () => {
    workerState.lastTickAt = new Date('2026-10-07T12:00:00.000Z');
    const res = await request(app).get('/health');
    expect(healthResponseSchema.parse(res.body).worker.lastTickAt).toBe('2026-10-07T12:00:00.000Z');
    workerState.lastTickAt = null;
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

  it('keeps the webhook route on a raw body and reports not_implemented', async () => {
    const res = await request(app).post('/webhooks/shopify').set('content-type', 'application/json').send('{"a":1}');
    expect(res.status).toBe(501);
    expect(errorEnvelopeSchema.parse(res.body).error.code).toBe('not_implemented');
  });
});
