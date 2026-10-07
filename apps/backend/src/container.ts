import type { ConfigService } from './core/config';
import type { Env } from './core/env';
import type { Logger } from './core/logger';
import { createAiModule, type AiService } from './modules/ai';
import { createAuthModule, type AuthModule } from './modules/auth';
import { createBatchesModule, type BatchesModule } from './modules/batches';
import { createCatalogModule, type CatalogModule } from './modules/catalog';
import { createGenerationModule } from './modules/generation';
import { createMediaModule, type MediaModule } from './modules/media';
import type { QueueModule } from './modules/queue';
import { createQueueModule } from './modules/queue/module';
import type { RateLimitService } from './modules/ratelimit';
import { createRateLimitModule } from './modules/ratelimit/module';
import { createShopifyModule, type ShopifyModule } from './modules/shopify';
import { createShopsModule, type ShopsModule } from './modules/shops';

// The composition root: every module is built here, once, from explicit dependencies.
// Modules never import each other's internals; they only receive the services they need.
export interface Container {
  shops: ShopsModule['service'];
  auth: AuthModule;
  shopify: ShopifyModule;
  rateLimit: RateLimitService;
  queue: QueueModule;
  ai: AiService;
  catalog: CatalogModule;
  media: MediaModule;
  batches: BatchesModule;
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
  const ai = createAiModule({ env, logger, getConfig });

  const requireAuth = auth.service.requireAuth;
  const catalog = createCatalogModule({ admin: shopify.service.admin, requireAuth, logger });

  // media and the queue need batches, and batches needs media and the queue, so those two edges
  // are late-bound: they are only called at request or job time, after the container is built.
  const late: { batches?: BatchesModule } = {};

  const media = createMediaModule({
    admin: shopify.service.admin,
    requireAuth,
    getConfig,
    logger,
    isMediaInUse: async (shopId, mediaId) => (await late.batches?.service.isMediaInUse(shopId, mediaId)) ?? false,
  });

  // The runner logs and swallows errors thrown by onTerminal, so batches aggregation never breaks a job.
  const queue = createQueueModule({
    getConfig,
    governor: rateLimit.governor,
    logger,
    // The handlers also download inputs and store the output in Shopify Files (an upload plus up to 2 minutes
    // for an image, up to 10 minutes for a video to process), so these budgets are larger than the provider calls.
    callTimeoutsMs: { plan: 120_000, image: 300_000, videoSubmit: 90_000, poll: 660_000 },
    onTerminal: async (job) => {
      await late.batches?.service.reportJobFinished(job);
    },
  });

  const batches = createBatchesModule({
    getConfig,
    getPromptVersions: () => config.getPromptVersions(),
    queue,
    governor: rateLimit.governor,
    catalog: catalog.service,
    media: media.service,
    shops,
    requireAuth,
    logger,
  });
  late.batches = batches;

  const generation = createGenerationModule({
    ai,
    batches: batches.service,
    media: media.service,
    getConfig,
    getPrompt: (name) => config.getPrompt(name),
    logger,
  });
  for (const handler of generation.handlers) queue.runner.registerHandler(handler);

  // Uninstall: cancel every batch and job of the shop. Redact: delete the shop's data in every module.
  shopify.service.registerUninstallHook(async (shop) => {
    await batches.service.cancelAllForShop(shop.id);
  });
  shopify.service.registerRedactHook(async (shopId) => {
    await batches.service.purgeShop(shopId);
    await queue.store.purgeShop(shopId);
    await media.service.purgeShop(shopId);
  });

  return { shops, auth, shopify, rateLimit, queue, ai, catalog, media, batches };
}
