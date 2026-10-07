import express, { type Express } from 'express';
import helmet from 'helmet';
import type { HealthResponse } from '@rs/shared';
import type { ConfigService } from './core/config';
import { getDbState } from './core/db';
import type { Env } from './core/env';
import { AppError, createErrorHandler, notFoundHandler } from './core/errors';
import { requestLogger } from './core/http';
import type { Logger } from './core/logger';
import type { WorkerState } from './core/worker';

export interface AppDeps {
  env: Env;
  logger: Logger;
  config: ConfigService;
  workerState: WorkerState;
}

export function createApp(deps: AppDeps): Express {
  const app = express();

  app.use(helmet());
  app.use(requestLogger(deps.logger));

  // Webhooks need the raw body for HMAC verification, so this route is registered before express.json.
  app.post('/webhooks/shopify', express.raw({ type: '*/*', limit: '1mb' }), (_req, _res, next) => {
    next(AppError.notImplemented('Shopify webhooks are not implemented yet'));
  });

  app.use(express.json({ limit: '1mb' }));

  app.get('/health', (_req, res) => {
    const body: HealthResponse = {
      ok: true,
      db: getDbState(),
      worker: { lastTickAt: deps.workerState.lastTickAt?.toISOString() ?? null },
      pausedLanes: [],
    };
    res.json(body);
  });

  app.use(notFoundHandler);
  app.use(createErrorHandler(deps.logger));

  return app;
}
