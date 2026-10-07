import type { ConfigService } from './core/config';
import type { Env } from './core/env';
import type { Logger } from './core/logger';
import { createAuthModule, type AuthModule } from './modules/auth';
import type { QueueJob, QueueModule } from './modules/queue';
import { createQueueModule } from './modules/queue/module';
import type { RateLimitService } from './modules/ratelimit';
import { createRateLimitModule } from './modules/ratelimit/module';
import { createShopifyModule, type ShopifyModule } from './modules/shopify';
import { createShopsModule, type ShopsModule } from './modules/shops';

export type JobTerminalListener = (job: QueueJob) => void | Promise<void>;

// The composition root: every module is built here, once, from explicit dependencies.
// Modules never import each other's internals; they only receive the services they need.
export interface Container {
  shops: ShopsModule['service'];
  auth: AuthModule;
  shopify: ShopifyModule;
  rateLimit: RateLimitService;
  queue: QueueModule;
  // Modules that react to job completion (batches) subscribe here. The queue runner calls every
  // listener after a job reaches succeeded, failed or cancelled. A listener's error is logged, not thrown.
  onJobTerminal(listener: JobTerminalListener): void;
}

export interface ContainerDeps {
  env: Env;
  logger: Logger;
  config: ConfigService;
}

export function createContainer({ env, logger, config }: ContainerDeps): Container {
  const getConfig = () => config.get();

  const shops = createShopsModule({ env, logger }).service;
  const auth = createAuthModule({ env, logger, shops, getGenerationConfig: getConfig });
  const shopify = createShopifyModule({ env, logger, shops, auth: auth.service });

  const rateLimit = createRateLimitModule({ getConfig, logger });

  const terminalListeners: JobTerminalListener[] = [];
  const queue = createQueueModule({
    getConfig,
    governor: rateLimit.governor,
    logger,
    onTerminal: async (job) => {
      for (const listener of terminalListeners) {
        try {
          await listener(job);
        } catch (err) {
          logger.error({ err, jobId: job.id }, 'job terminal listener failed');
        }
      }
    },
  });

  // Uninstall: stop all work for the shop. Redact: delete the queue's data for the shop.
  shopify.service.registerUninstallHook(async (shop) => {
    await queue.store.cancelByShop(shop.id);
  });
  shopify.service.registerRedactHook(async (shopId) => {
    await queue.store.purgeShop(shopId);
  });

  return {
    shops,
    auth,
    shopify,
    rateLimit,
    queue,
    onJobTerminal(listener) {
      terminalListeners.push(listener);
    },
  };
}
