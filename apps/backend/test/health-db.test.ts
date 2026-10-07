import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { healthResponseSchema } from '@rs/shared';
import { createApp } from '../src/app';
import { createContainer } from '../src/container';
import { createConfigService } from '../src/core/config';
import { parseEnv } from '../src/core/env';
import { createLogger } from '../src/core/logger';
import { MONGO_START_TIMEOUT_MS, startTestMongo, type TestMongo } from './helpers/mongo';

const logger = createLogger('silent');
const config = createConfigService({ logger, watch: false });
const env = parseEnv({});
const container = createContainer({ env, logger, config });
const app = createApp({ env, logger, config, container });

let mongo: TestMongo;

beforeAll(async () => {
  mongo = await startTestMongo();
}, MONGO_START_TIMEOUT_MS);

afterAll(async () => {
  config.close();
  await mongo.stop();
});

describe('GET /health with a connected database', () => {
  it('reports the queue tick and paused lanes', async () => {
    await container.queue.runner.tickOnce();
    const lane = 'vertex:gemini-2.5-flash-image';
    await container.rateLimit.governor.recordFailure(lane, { kind: 'rate_limited', retryDelayMs: 30_000, rawBody: null });

    const res = await request(app).get('/health');
    expect(res.status).toBe(200);
    const body = healthResponseSchema.parse(res.body);
    expect(body.db).toBe('connected');
    expect(body.worker.lastTickAt).not.toBeNull();
    expect(body.pausedLanes).toHaveLength(1);
    expect(body.pausedLanes[0]).toMatchObject({ lane, reason: 'rate_limited' });
  });
});
