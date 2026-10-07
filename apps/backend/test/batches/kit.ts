import express, { type Express, type RequestHandler } from 'express';
import { Types } from 'mongoose';
import { pino } from 'pino';
import request from 'supertest';
import {
  defaultGenerationConfig,
  isTerminalBatchStatus,
  type BatchDetail,
  type BatchSummary,
  type CreateBatchInput,
  type GenerationConfig,
} from '@rs/shared';
import { createConfigService, type ConfigService } from '../../src/core/config';
import { AppError, createErrorHandler } from '../../src/core/errors';
import { createAiModule, type AiService } from '../../src/modules/ai';
import { FAKE_JPEG } from '../../src/modules/ai/fake-media';
import type { AuthenticatedRequest } from '../../src/modules/auth';
import { createBatchesModule, type BatchesModule } from '../../src/modules/batches';
import { createGenerationModule, type GenerationService } from '../../src/modules/generation';
import { createQueueModule, type QueueJob, type QueueModule } from '../../src/modules/queue';
import { createRateLimitModule } from '../../src/modules/ratelimit';
import type { Governor } from '../../src/modules/ratelimit';
import type { ShopRecord } from '../../src/modules/shops';
import { createClock, deferred, openLane, type TestClock } from '../queue/kit';
import { createFakeCatalog, createFakeMedia, type FakeCatalog, type FakeMedia } from './fakes';
import { createScriptedAi, type ScriptedAi } from './scripted-ai';

export const silent = pino({ level: 'silent' });

export function testConfig(): GenerationConfig {
  const base = structuredClone(defaultGenerationConfig);
  return {
    ...base,
    provider: 'fake',
    models: { planner: 'fake-planner', image: 'fake-image', video: 'fake-video' },
    fake: { latencyMs: 0, rateLimitProbability: 0 },
    lanes: {
      'fake:*': openLane({ maxConcurrent: 4 }),
      'fake:fake-video': openLane({ maxConcurrent: 3, pollLane: 'fake:poll' }),
      'fake:poll': openLane(),
    },
  };
}

export const SHOP_A = new Types.ObjectId().toHexString();
export const SHOP_B = new Types.ObjectId().toHexString();
export const USER = new Types.ObjectId().toHexString();

export interface Kit {
  clock: TestClock;
  // The live config. Mutate it between ticks like a hot reload.
  config: { current: GenerationConfig };
  prompts: ConfigService;
  queue: QueueModule;
  governor: Governor;
  ai: ScriptedAi;
  catalog: FakeCatalog;
  media: FakeMedia;
  batches: BatchesModule;
  generation: GenerationService;
  app: Express;
  // URLs the handlers downloaded.
  fetched: string[];
  // Overrides the download response for a url (return undefined for the default image).
  fetchRule: { current?: (url: string) => Response | undefined };
  shopStatus: Map<string, ShopRecord['status']>;
  // Jobs reported to the batches listener.
  reported: QueueJob[];
  tick(): Promise<void>;
  // Ticks (advancing the clock stepMs per tick) until done() is true. Returns the tick count.
  drive(done: () => Promise<boolean>, options?: { stepMs?: number; maxTicks?: number }): Promise<number>;
  driveToTerminal(batchId: string, shopId?: string): Promise<BatchDetail>;
  detail(batchId: string, shopId?: string): Promise<BatchDetail>;
  // Adds n products to the fake catalog.
  products(n: number): string[];
  reference(shopId?: string, mediaType?: 'image' | 'video'): string;
  create(input: Omit<CreateBatchInput, 'idempotencyKey'> & { idempotencyKey?: string }, shopId?: string): Promise<BatchSummary>;
  api(shopId?: string): { post: (path: string) => request.Test; get: (path: string) => request.Test };
}

export interface KitOptions {
  config?: (config: GenerationConfig) => void;
}

export function createKit(options: KitOptions = {}): Kit {
  const clock = createClock();
  const config = { current: testConfig() };
  options.config?.(config.current);
  const getConfig = (): GenerationConfig => config.current;

  const prompts = createConfigService({ logger: silent, watch: false });
  const governor = createRateLimitModule({ getConfig, logger: silent, now: clock.now }).governor;
  const reported: QueueJob[] = [];
  const listener: { current?: (job: QueueJob) => Promise<void> } = {};
  const queue = createQueueModule({
    getConfig,
    governor,
    logger: silent,
    now: clock.now,
    instanceId: 'test-runner',
    random: () => 0,
    onTerminal: async (job) => {
      reported.push(job);
      await listener.current?.(job);
    },
  });

  const real: AiService = createAiModule({
    env: { GOOGLE_CLOUD_PROJECT: 'test-project', GEMINI_API_KEY: 'test-key' },
    logger: silent,
    getConfig,
  });
  const ai = createScriptedAi(real);
  const catalog = createFakeCatalog();
  const media = createFakeMedia(clock.now);

  const shopStatus = new Map<string, ShopRecord['status']>();
  const requireActive = async (shopId: string): Promise<ShopRecord> => {
    const status = shopStatus.get(shopId) ?? 'active';
    if (status !== 'active') throw AppError.shopReauthRequired();
    return { id: shopId, shopDomain: 'test.myshopify.com', shopGid: null, name: null, email: null, currencyCode: null, ianaTimezone: null, status, scopes: [] };
  };

  const requireAuth: RequestHandler = (req, _res, next) => {
    (req as AuthenticatedRequest).auth = { userId: USER, shopId: req.header('x-shop') ?? SHOP_A, shopDomain: 'test.myshopify.com' };
    next();
  };

  const batches = createBatchesModule({
    getConfig,
    getPromptVersions: () => prompts.getPromptVersions(),
    queue,
    governor,
    catalog,
    media,
    shops: { requireActive },
    requireAuth,
    logger: silent,
    now: clock.now,
  });
  listener.current = (job) => batches.service.reportJobFinished(job);

  const fetched: string[] = [];
  const fetchRule: Kit['fetchRule'] = {};
  const fetchImpl = (async (input: string | URL | Request): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    fetched.push(url);
    return (
      fetchRule.current?.(url) ?? new Response(new Uint8Array(FAKE_JPEG), { headers: { 'content-type': 'image/jpeg' } })
    );
  }) as typeof fetch;

  const generation = createGenerationModule({
    ai: ai.service,
    batches: batches.service,
    media,
    getConfig,
    getPrompt: (name) => prompts.getPrompt(name),
    logger: silent,
    fetchImpl,
    now: clock.now,
  });
  for (const handler of generation.handlers) queue.runner.registerHandler(handler);

  const app = express();
  app.use(express.json());
  app.use('/api/v1', batches.router);
  app.use(createErrorHandler(silent));

  const tick = async (): Promise<void> => {
    await queue.runner.tickOnce();
    await queue.runner.idle();
  };

  const kit: Kit = {
    clock,
    config,
    prompts,
    queue,
    governor,
    ai,
    catalog,
    media,
    batches,
    generation,
    app,
    fetched,
    fetchRule,
    shopStatus,
    reported,
    tick,
    async drive(done, driveOptions = {}) {
      const { stepMs = 1000, maxTicks = 300 } = driveOptions;
      for (let ticks = 1; ticks <= maxTicks; ticks += 1) {
        await tick();
        if (await done()) return ticks;
        clock.advance(stepMs);
      }
      throw new Error(`drive: condition not met after ${maxTicks} ticks`);
    },
    detail: (batchId, shopId = SHOP_A) => batches.service.getBatch(shopId, batchId),
    async driveToTerminal(batchId, shopId = SHOP_A) {
      await kit.drive(async () => isTerminalBatchStatus((await kit.detail(batchId, shopId)).status));
      return kit.detail(batchId, shopId);
    },
    products: (n) => Array.from({ length: n }, () => catalog.addProduct()),
    reference: (shopId = SHOP_A, mediaType = 'image') => media.addReference({ shopId, mediaType }),
    create: (input, shopId = SHOP_A) =>
      batches.service.createBatch({ shopId, userId: USER }, { idempotencyKey: crypto.randomUUID(), ...input }),
    api(shopId = SHOP_A) {
      const agent = request(app);
      return {
        post: (path) => agent.post(`/api/v1${path}`).set('x-shop', shopId),
        get: (path) => agent.get(`/api/v1${path}`).set('x-shop', shopId),
      };
    },
  };
  return kit;
}

// Holds provider calls (from a hook) until opened, so a test can act while jobs are running.
export function createGate() {
  const opened = deferred<void>();
  let waiting = 0;
  return {
    async hold(): Promise<void> {
      waiting += 1;
      await opened.promise;
    },
    open: () => opened.resolve(),
    get waiting() {
      return waiting;
    },
  };
}

export async function prepareIndexes(kit: Kit): Promise<void> {
  await Promise.all([kit.batches.ensureIndexes(), kit.queue.ensureIndexes()]);
}
