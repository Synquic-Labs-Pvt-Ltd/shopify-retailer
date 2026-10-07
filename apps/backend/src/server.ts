import type { Server } from 'node:http';
import { createApp } from './app';
import { createContainer } from './container';
import { createConfigService } from './core/config';
import { connectDbWithRetry, disconnectDb } from './core/db';
import { EnvValidationError, loadDotEnv, parseEnv } from './core/env';
import { createLogger } from './core/logger';

async function main(): Promise<void> {
  loadDotEnv();
  const env = parseEnv();
  const logger = createLogger(env.LOG_LEVEL);
  const config = createConfigService({ logger, configPath: env.GENERATION_CONFIG_PATH });
  const container = createContainer({ env, logger, config });
  const abort = new AbortController();

  let server: Server | undefined;

  if (env.ROLE === 'api' || env.ROLE === 'all') {
    const app = createApp({ env, logger, config, container });
    server = app.listen(env.PORT, (error?: Error) => {
      if (error) {
        logger.fatal({ err: error }, 'cannot listen');
        process.exit(1);
      }
      logger.info({ port: env.PORT, role: env.ROLE }, 'api listening');
    });
  }

  const runsWorker = env.ROLE === 'worker' || env.ROLE === 'all';
  // The HTTP server is already up so /health answers while Mongo is down. The queue starts once Mongo is connected.
  void connectDbWithRetry(env.MONGODB_URI, logger, { signal: abort.signal }).then(() => {
    if (runsWorker && !abort.signal.aborted) {
      container.queue.runner.start();
      logger.info({ role: env.ROLE }, 'queue runner started');
    }
  });

  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, 'shutting down');
    abort.abort();
    if (server !== undefined) {
      const httpServer = server;
      await new Promise<void>((resolve) => {
        httpServer.close(() => resolve());
      });
    }
    // Let in-flight jobs finish or release their leases before the connection goes away.
    await container.queue.runner.stop();
    config.close();
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
