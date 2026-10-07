import type { Server } from 'node:http';
import { createApp } from './app';
import { createConfigService } from './core/config';
import { connectDbWithRetry, disconnectDb } from './core/db';
import { EnvValidationError, loadDotEnv, parseEnv } from './core/env';
import { createLogger } from './core/logger';
import { createWorkerState, startWorkerStub, type WorkerHandle } from './core/worker';

async function main(): Promise<void> {
  loadDotEnv();
  const env = parseEnv();
  const logger = createLogger(env.LOG_LEVEL);
  const config = createConfigService({ logger, configPath: env.GENERATION_CONFIG_PATH });
  const workerState = createWorkerState();
  const abort = new AbortController();

  let server: Server | undefined;
  let worker: WorkerHandle | undefined;

  if (env.ROLE === 'api' || env.ROLE === 'all') {
    const app = createApp({ env, logger, config, workerState });
    server = app.listen(env.PORT, (error?: Error) => {
      if (error) {
        logger.fatal({ err: error }, 'cannot listen');
        process.exit(1);
      }
      logger.info({ port: env.PORT, role: env.ROLE }, 'api listening');
    });
  }

  if (env.ROLE === 'worker' || env.ROLE === 'all') {
    worker = startWorkerStub({ config, logger, state: workerState });
  }

  void connectDbWithRetry(env.MONGODB_URI, logger, { signal: abort.signal });

  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, 'shutting down');
    abort.abort();
    worker?.stop();
    config.close();
    if (server !== undefined) {
      const httpServer = server;
      await new Promise<void>((resolve) => {
        httpServer.close(() => resolve());
      });
    }
    await disconnectDb();
    process.exit(0);
  };

  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

main().catch((err: unknown) => {
  if (err instanceof EnvValidationError) {
    console.error(err.message);
  } else {
    console.error(err);
  }
  process.exit(1);
});
