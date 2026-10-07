import type { Request, RequestHandler, Router } from 'express';
import type { GenerationConfig } from '@rs/shared';
import type { Logger } from '../../core/logger';
import type { ShopsInternalService } from '../shops';
import { createJwtService } from './jwt';
import { createOAuthFlow, type AuthEnv } from './oauth-flow';
import { createOAuthStateStore } from './oauth-state';
import { createAuthRouters } from './routes';
import { createAuthService } from './service';
import { createSessionService } from './sessions';
import { createShopifyOAuthClient } from './shopify-oauth';

export interface AuthContext {
  userId: string;
  shopId: string;
  shopDomain: string;
}

// A request after requireAuth has run.
export type AuthenticatedRequest = Request & { auth: AuthContext };

export interface AuthService {
  // Verifies the bearer JWT, loads the shop and sets req.auth. 401 unauthorized, 409 shop_reauth_required.
  requireAuth: RequestHandler;
  verifyAccessToken(token: string): Promise<AuthContext>;
  // app/uninstalled: revokes every session of the shop.
  revokeAllSessions(shopId: string): Promise<void>;
  // shop/redact: deletes users, sessions, login codes and oauth states of the shop.
  purgeShop(shopId: string): Promise<void>;
}

export type { AuthEnv };

export interface AuthModuleDeps {
  env: AuthEnv;
  logger: Logger;
  shops: ShopsInternalService;
  // Read live on every GET /api/v1/me, so config hot reload applies.
  getGenerationConfig: () => GenerationConfig;
  fetchImpl?: typeof fetch;
  now?: () => Date;
  // Requests per minute per IP on the auth routes. Default 30.
  rateLimitPerMinute?: number;
}

export interface AuthModule {
  service: AuthService;
  // Mount at the app root, before express.json is fine: GET /, /auth/shopify/start, /auth/shopify/callback.
  browserRouter: Router;
  // Mount at /api/v1 after express.json: POST /auth/exchange, /auth/refresh, /auth/logout and GET /me.
  apiRouter: Router;
}

export function createAuthModule(deps: AuthModuleDeps): AuthModule {
  const { env, logger, shops } = deps;
  const now = deps.now ?? (() => new Date());

  const jwt = createJwtService(env.JWT_SECRET, now);
  const sessions = createSessionService({ logger, shops, jwt, now });
  const service = createAuthService({ shops, jwt, sessions });
  const flow = createOAuthFlow({
    env,
    logger,
    shops,
    now,
    states: createOAuthStateStore(now),
    shopify: createShopifyOAuthClient({
      fetchImpl: deps.fetchImpl ?? fetch,
      logger,
      clientId: env.SHOPIFY_API_KEY,
      clientSecret: env.SHOPIFY_API_SECRET,
      apiVersion: env.SHOPIFY_API_VERSION,
    }),
  });

  const { browserRouter, apiRouter } = createAuthRouters({
    env,
    shops,
    flow,
    sessions,
    requireAuth: service.requireAuth,
    getGenerationConfig: deps.getGenerationConfig,
    rateLimitPerMinute: deps.rateLimitPerMinute,
  });

  return { service, browserRouter, apiRouter };
}
