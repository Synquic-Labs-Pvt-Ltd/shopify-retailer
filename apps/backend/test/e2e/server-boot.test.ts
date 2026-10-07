import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { errorEnvelopeSchema, healthResponseSchema } from '@rs/shared';
import { DEFAULT_CONFIG_PATH, parseGenerationConfig } from '../../src/core/config';
import { MONGO_START_TIMEOUT_MS, startTestMongo, type TestMongo } from '../helpers/mongo';
import { e2eConfig } from './support/harness';
import { waitFor } from './support/wait';

const BACKEND_ROOT = fileURLToPath(new URL('../../', import.meta.url));

let mongo: TestMongo;
let child: ChildProcess;
let baseUrl = '';
let directory = '';
let output = '';

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      server.close(() => (typeof address === 'object' && address !== null ? resolve(address.port) : reject(new Error('no port'))));
    });
  });
}

beforeAll(async () => {
  mongo = await startTestMongo('rs_e2e_boot');
  directory = mkdtempSync(join(tmpdir(), 'rs-boot-'));
  const configPath = join(directory, 'generation.config.json');
  writeFileSync(configPath, JSON.stringify(e2eConfig(parseGenerationConfig(readFileSync(DEFAULT_CONFIG_PATH, 'utf8')))));
  const port = await freePort();
  baseUrl = `http://127.0.0.1:${port}`;

  // The real entry point, in its own process, with a real environment.
  child = spawn(process.execPath, ['--import', 'tsx', 'src/server.ts'], {
    cwd: BACKEND_ROOT,
    env: {
      PATH: process.env.PATH ?? '',
      SystemRoot: process.env.SystemRoot ?? '',
      PORT: String(port),
      ROLE: 'all',
      MONGODB_URI: mongo.uri,
      PUBLIC_BASE_URL: 'https://studio.example.com',
      GENERATION_CONFIG_PATH: configPath,
      LOG_LEVEL: 'info',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout?.on('data', (chunk: Buffer) => (output += chunk.toString()));
  child.stderr?.on('data', (chunk: Buffer) => (output += chunk.toString()));
}, MONGO_START_TIMEOUT_MS);

afterAll(async () => {
  child.kill();
  await new Promise((resolve) => setTimeout(resolve, 200));
  rmSync(directory, { recursive: true, force: true });
  await mongo.stop();
});

describe('the real server entry point', () => {
  it('boots, connects to Mongo and runs the worker loop on its own', async () => {
    const health = await waitFor(
      async () => {
        try {
          const res = await fetch(`${baseUrl}/health`);
          const body = healthResponseSchema.parse(await res.json());
          return body.db === 'connected' && body.worker.lastTickAt !== null ? body : null;
        } catch {
          return null;
        }
      },
      { timeoutMs: 60_000, intervalMs: 250, label: `the server to be healthy\n${output}` },
    );
    expect(health).toMatchObject({ ok: true, db: 'connected', pausedLanes: [] });
    expect(output).toContain('queue runner started');

    // The tick loop keeps running by itself.
    const first = health.worker.lastTickAt ?? '';
    const later = await waitFor(
      async () => {
        const body = healthResponseSchema.parse(await (await fetch(`${baseUrl}/health`)).json());
        return body.worker.lastTickAt !== null && body.worker.lastTickAt > first ? body.worker.lastTickAt : null;
      },
      { timeoutMs: 10_000, intervalMs: 100, label: 'the next tick' },
    );
    expect(later > first).toBe(true);
  }, 90_000);

  it('serves the OAuth redirect and the error envelope over a real socket', async () => {
    const challenge = 'A'.repeat(43);
    const start = await fetch(`${baseUrl}/auth/shopify/start?shop=boot-store&challenge=${challenge}`, { redirect: 'manual' });
    expect(start.status).toBe(302);
    const location = new URL(start.headers.get('location') ?? '');
    expect(location.origin).toBe('https://boot-store.myshopify.com');
    expect(location.searchParams.get('redirect_uri')).toBe('https://studio.example.com/auth/shopify/callback');

    const unauthorized = await fetch(`${baseUrl}/api/v1/batches`);
    expect(unauthorized.status).toBe(401);
    expect(errorEnvelopeSchema.parse(await unauthorized.json()).error.code).toBe('unauthorized');
    expect(unauthorized.headers.get('x-request-id')).toBeTruthy();
  });
});
