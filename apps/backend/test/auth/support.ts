import { createHash, randomBytes } from 'node:crypto';
import express, { type Express } from 'express';
import request from 'supertest';
import { defaultGenerationConfig, type AuthSessionResponse } from '@rs/shared';
import { createErrorHandler, notFoundHandler } from '../../src/core/errors';
import { parseEnv, type Env } from '../../src/core/env';
import { createLogger } from '../../src/core/logger';
import { createAuthModule, type AuthModule } from '../../src/modules/auth';
import { createShopsModule, type ShopsInternalService } from '../../src/modules/shops';
import { signSessionToken, type SessionTokenSpec } from '../helpers/session-token';
import { createFakeShopify, type ApproveOptions, type FakeShopify } from '../shopify/fake-shopify';

export const SHOP = 'demo-store.myshopify.com';
export const logger = createLogger('silent');

export interface Clock {
  offsetMs: number;
  now(): Date;
}

export interface Harness {
  app: Express;
  env: Env;
  clock: Clock;
  shops: ShopsInternalService;
  auth: AuthModule;
  fake: FakeShopify;
}

export function createClock(): Clock {
  const clock: Clock = { offsetMs: 0, now: () => new Date(Date.now() + clock.offsetMs) };
  return clock;
}

export function createHarness(options: { rateLimitPerMinute?: number; envOverrides?: Record<string, string> } = {}): Harness {
  const env = parseEnv({ PUBLIC_BASE_URL: 'https://studio.example.com', ...options.envOverrides });
  const clock = createClock();
  const fake = createFakeShopify({
    apiKey: env.SHOPIFY_API_KEY,
    apiSecret: env.SHOPIFY_API_SECRET,
    apiVersion: env.SHOPIFY_API_VERSION,
    now: clock.now,
  });
  const shops = createShopsModule({ env, logger, fetchImpl: fake.fetchImpl, now: clock.now, lockPollMs: 10 }).service;
  const auth = createAuthModule({
    env,
    logger,
    shops,
    fetchImpl: fake.fetchImpl,
    now: clock.now,
    getGenerationConfig: () => defaultGenerationConfig,
    rateLimitPerMinute: 'rateLimitPerMinute' in options ? options.rateLimitPerMinute : 1000,
  });

  const app = express();
  app.use(auth.browserRouter);
  app.use(express.json());
  app.use('/api/v1', auth.apiRouter);
  app.use(notFoundHandler);
  app.use(createErrorHandler(logger));
  return { app, env, clock, shops, auth, fake };
}

// A Shopify App Bridge session token for the harness's app, minted on the harness clock.
export function sessionToken(harness: Harness, spec: Partial<SessionTokenSpec> = {}): Promise<string> {
  return signSessionToken({
    shop: SHOP,
    apiKey: harness.env.SHOPIFY_API_KEY,
    apiSecret: harness.env.SHOPIFY_API_SECRET,
    at: harness.clock.now().getTime(),
    ...spec,
  });
}

export interface Pkce {
  verifier: string;
  challenge: string;
}

export function createPkce(): Pkce {
  const verifier = randomBytes(32).toString('base64url');
  return { verifier, challenge: createHash('sha256').update(verifier).digest('base64url') };
}

// Runs GET /auth/shopify/start for a shop and returns the Shopify authorize URL.
export async function startLogin(harness: Harness, pkce: Pkce, shop = SHOP): Promise<string> {
  const res = await request(harness.app).get('/auth/shopify/start').query({ shop, challenge: pkce.challenge });
  if (res.status !== 302) throw new Error(`start returned ${res.status}: ${res.text}`);
  return String(res.headers.location);
}

// Drives the whole browser flow (start, offline hop if needed, online hop) and returns the login code.
export async function loginForCode(harness: Harness, pkce: Pkce, approve: ApproveOptions = {}, shop = SHOP): Promise<string> {
  let location = await startLogin(harness, pkce, shop);
  for (let hop = 0; hop < 3; hop++) {
    if (!location.startsWith('https://')) break;
    const callback = harness.fake.approve(location, approve);
    const res = await request(harness.app).get(callback);
    if (res.status !== 302) throw new Error(`callback returned ${res.status}: ${res.text}`);
    location = String(res.headers.location);
  }
  const code = new URL(location).searchParams.get('code');
  if (code === null) throw new Error(`no login code in ${location}`);
  return code;
}

export async function exchange(harness: Harness, code: string, pkce: Pkce): Promise<request.Response> {
  return request(harness.app).post('/api/v1/auth/exchange').send({ code, codeVerifier: pkce.verifier, platform: 'android', deviceName: 'Pixel' });
}

// Full login: returns the session response.
export async function login(harness: Harness, approve: ApproveOptions = {}, shop = SHOP): Promise<AuthSessionResponse> {
  const pkce = createPkce();
  const code = await loginForCode(harness, pkce, approve, shop);
  const res = await exchange(harness, code, pkce);
  if (res.status !== 200) throw new Error(`exchange returned ${res.status}: ${res.text}`);
  return res.body as AuthSessionResponse;
}
