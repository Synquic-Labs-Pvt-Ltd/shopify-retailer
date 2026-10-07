import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Express } from 'express';
import mongoose from 'mongoose';
import { pino, type Logger } from 'pino';
import { vi } from 'vitest';
import { isTerminalBatchStatus, type GenerationConfig, type LaneConfig } from '@rs/shared';
import { createApp } from '../../../src/app';
import { createContainer, type Container } from '../../../src/container';
import { DEFAULT_CONFIG_PATH, createConfigService, parseGenerationConfig, type ConfigService } from '../../../src/core/config';
import { parseEnv, type Env } from '../../../src/core/env';
import { BatchModel, type BatchDoc } from '../../../src/modules/batches/models';
import { JobModel } from '../../../src/modules/queue/models';
import { MONGO_START_TIMEOUT_MS, startTestMongo, type TestMongo } from '../../helpers/mongo';
import { createShopifyStub, type ShopifyStub } from './shopify-stub';
import { sleep } from './wait';

export { MONGO_START_TIMEOUT_MS };

export const PUBLIC_BASE_URL = 'https://studio.example.com';

// Fast queue, generous lanes, a fake provider without latency or simulated 429s. Tests tighten lanes
// themselves where they need to see pacing.
export function e2eConfig(base: GenerationConfig): GenerationConfig {
  const config = structuredClone(base);
  const open: LaneConfig = { rpm: 600, rph: null, rpd: null, maxConcurrent: 50, safetyFactor: 1, dailyResetTimeZone: 'UTC', pollLane: null };
  config.provider = 'fake';
  config.fake = { latencyMs: 0, rateLimitProbability: 0 };
  config.queue = { ...config.queue, tickMs: 20, backoffBaseMs: 1, backoffMaxMs: 5, videoPollIntervalMs: 30 };
  config.batch = { ...config.batch, maxJobsPerShopPerDay: 1000 };
  config.lanes = {
    'fake:*': open,
    [`fake:${config.models.video}`]: { ...open, pollLane: 'fake:poll' },
    'fake:poll': { ...open, rpm: 6000, maxConcurrent: null },
  };
  return config;
}

export interface DriveOptions {
  timeoutMs?: number;
  intervalMs?: number;
}

export interface E2e {
  env: Env;
  logger: Logger;
  // Warnings and errors the backend logged, for failure diagnostics.
  logs: string[];
  stub: ShopifyStub;
  config: ConfigService;
  container: Container;
  app: Express;
  mongo: TestMongo;
  // Rewrites the generation config file and hot reloads it, like an operator editing it live.
  editConfig(mutate: (config: GenerationConfig) => void): void;
  // One queue tick, with no timers involved.
  tick(): Promise<void>;
  // Ticks until the condition holds. Fails fast if the backend reached for an unknown host.
  drive(until: () => Promise<boolean>, options?: DriveOptions): Promise<void>;
  driveBatch(batchId: string, options?: DriveOptions): Promise<BatchDoc>;
  // Resolves when no handler started by the runner is still running.
  settle(): Promise<void>;
  describeJobs(batchId?: string): Promise<string>;
  // The warnings and errors logged so far as "level message" lines, minus the messages in `allow`.
  problems(allow?: string[]): string[];
  stop(): Promise<void>;
}

export interface StartOptions {
  dbName?: string;
  config?: (config: GenerationConfig) => void;
}

export async function startE2e(options: StartOptions = {}): Promise<E2e> {
  const stub = createShopifyStub({
    apiKey: 'e2e-api-key',
    apiSecret: 'e2e-api-secret',
    apiVersion: '2026-10',
    redirectUri: `${PUBLIC_BASE_URL}/auth/shopify/callback`,
  });
  // The modules capture the global fetch when they are created, so the stub goes in first.
  vi.stubGlobal('fetch', stub.fetch);

  const env = parseEnv({
    PUBLIC_BASE_URL,
    SHOPIFY_API_KEY: 'e2e-api-key',
    SHOPIFY_API_SECRET: 'e2e-api-secret',
    JWT_SECRET: 'e2e-jwt-secret-0123456789abcdef0123456789abcdef',
    TOKEN_ENC_KEY: 'ab'.repeat(32),
  });

  const directory = mkdtempSync(join(tmpdir(), 'rs-e2e-'));
  const configPath = join(directory, 'generation.config.json');
  const initial = e2eConfig(parseGenerationConfig(readFileSync(DEFAULT_CONFIG_PATH, 'utf8')));
  options.config?.(initial);
  writeFileSync(configPath, JSON.stringify(initial, null, 2));

  const logs: string[] = [];
  const logger = pino({ level: process.env.E2E_LOG_LEVEL ?? 'warn' }, {
    write: (line: string) => {
      logs.push(line);
      if (process.env.E2E_LOG_LEVEL !== undefined) process.stderr.write(line);
    },
  });

  const mongo = await startTestMongo(options.dbName ?? 'rs_e2e');
  const config = createConfigService({ logger, configPath, watch: false });
  const container = createContainer({ env, logger, config });
  const app = createApp({ env, logger, config, container });
  await Promise.all(mongoose.modelNames().map((name) => mongoose.model(name).init()));
  await container.media.ensureIndexes();
  await container.batches.ensureIndexes();

  const describeJobs = async (batchId?: string): Promise<string> => {
    const jobs = await JobModel.find(batchId === undefined ? {} : { batchId }).sort({ createdAt: 1 }).lean();
    const lines = jobs.map(
      (job) =>
        `${job.type}#${job.outputIndex ?? '-'} ${job.status} attempts=${job.attempts}/${job.maxAttempts} deferrals=${job.deferrals}` +
        (job.error?.code === undefined ? '' : ` error=${job.error.code}: ${job.error.message ?? ''}`),
    );
    return [...lines, ...logs.slice(-15)].join('\n');
  };

  const e2e: E2e = {
    env,
    logger,
    logs,
    stub,
    config,
    container,
    app,
    mongo,

    editConfig(mutate) {
      const previous = readFileSync(configPath, 'utf8');
      const next = parseGenerationConfig(previous);
      mutate(next);
      writeFileSync(configPath, JSON.stringify(next, null, 2));
      const result = config.reload();
      if (!result.ok) {
        // Leave the file as the last good config, like an operator fixing the typo.
        writeFileSync(configPath, previous);
        throw new Error(`The config edit was rejected: ${result.errors.join('; ')}`);
      }
    },

    tick: () => container.queue.runner.tickOnce(),

    async drive(until, driveOptions = {}) {
      const { timeoutMs = 60_000, intervalMs = 25 } = driveOptions;
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        await container.queue.runner.tickOnce();
        if (stub.state.unexpected.length > 0) throw new Error(`Unexpected outbound requests: ${stub.state.unexpected.join(', ')}`);
        if (await until()) return;
        if (Date.now() > deadline) throw new Error(`drive timed out after ${timeoutMs} ms\n${await describeJobs()}`);
        await sleep(intervalMs);
      }
    },

    async driveBatch(batchId, driveOptions) {
      const terminal = async (): Promise<boolean> => {
        const batch = await BatchModel.findById(batchId).lean();
        return batch !== null && isTerminalBatchStatus(batch.status);
      };
      await e2e.drive(terminal, driveOptions);
      const batch = await BatchModel.findById(batchId).lean<BatchDoc>();
      if (batch === null) throw new Error(`Batch ${batchId} disappeared`);
      return batch;
    },

    settle: () => container.queue.runner.idle(),
    describeJobs,

    problems(allow = []) {
      return logs
        .map((line) => JSON.parse(line) as { level: number; msg?: string })
        .filter((entry) => !allow.includes(entry.msg ?? ''))
        .map((entry) => `${entry.level >= 50 ? 'error' : 'warn'} ${entry.msg ?? ''}`);
    },

    async stop() {
      await container.queue.runner.idle();
      config.close();
      vi.unstubAllGlobals();
      await mongo.stop();
      rmSync(directory, { recursive: true, force: true });
    },
  };
  return e2e;
}
