import express, { type Express } from 'express';
import helmet from 'helmet';
import type { HealthResponse } from '@rs/shared';
import type { Container } from './container';
import { createApiLimiter } from './core/api-limiter';
import type { ConfigService } from './core/config';
import { getDbState } from './core/db';
import type { Env } from './core/env';
import { createErrorHandler, notFoundHandler } from './core/errors';
import { requestLogger } from './core/http';
import type { Logger } from './core/logger';

export interface AppDeps {
  env: Env;
  logger: Logger;
  config: ConfigService;
  container: Container;
}

export function createApp(deps: AppDeps): Express {
  const { container } = deps;
  const app = express();

  // Behind a reverse proxy or tunnel the client IP comes from X-Forwarded-For (auth rate limiting).
  app.set('trust proxy', 1);
  app.use(helmet());
  app.use(requestLogger(deps.logger));

  // Webhooks bring their own raw body parser for HMAC verification, so they are mounted before express.json.
  app.use(container.shopify.webhookRouter);

  app.use(express.json({ limit: '1mb' }));

  // GET /, /auth/shopify/start, /auth/shopify/callback
  app.use(container.auth.browserRouter);
  // POST /auth/exchange|refresh|logout and GET /me
  app.use('/api/v1', container.auth.apiRouter);

  // Everything below is authenticated per route (requireAuth) and shares the per-user API rate limit.
  app.use('/api/v1', createApiLimiter());
  app.use('/api/v1', container.catalog.router);
  app.use('/api/v1', container.media.router);

  app.get('/health', async (_req, res) => {
    const db = getDbState();
    let pausedLanes: HealthResponse['pausedLanes'] = [];
    if (db === 'connected') {
      try {
        const paused = await container.rateLimit.governor.listPaused();
        pausedLanes = paused.map((lane) => ({
          lane: lane.lane,
          reason: lane.reason,
          pausedUntil: lane.pausedUntil.toISOString(),
        }));
      } catch (err) {
        deps.logger.error({ err }, 'health: cannot list paused lanes');
      }
    }
    const body: HealthResponse = {
      ok: true,
      db,
      worker: { lastTickAt: container.queue.runner.lastTickAt?.toISOString() ?? null },
      pausedLanes,
    };
    res.json(body);
  });

  app.use(notFoundHandler);
  app.use(createErrorHandler(deps.logger));

  return app;
}
