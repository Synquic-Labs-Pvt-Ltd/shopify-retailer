import type { Router } from 'express';
import type { WebhookTopic } from '@rs/shared';
import type { Env } from '../../core/env';
import type { Logger } from '../../core/logger';
import type { AuthService } from '../auth';
import type { ShopRecord, ShopsInternalService } from '../shops';
import { createAdminClient } from './admin-client';
import { createWebhookRouter, type WebhookRegistry } from './webhooks';

export interface ShopifyThrottleStatus {
  maximumAvailable: number;
  currentlyAvailable: number;
  restoreRate: number;
}

export interface ShopifyQueryCost {
  requestedQueryCost: number;
  actualQueryCost: number | null;
  throttleStatus: ShopifyThrottleStatus;
}

export interface GraphqlResponse<TData> {
  data: TData;
  cost: ShopifyQueryCost | null;
}

// Admin GraphQL only (SPEC 5). Pins SHOPIFY_API_VERSION, backs off on THROTTLED (max 3 retries)
// and maps GraphQL and HTTP errors to AppError.
export interface ShopifyAdminClient {
  query<TData>(shopId: string, query: string, variables?: Record<string, unknown>): Promise<GraphqlResponse<TData>>;
}

export interface WebhookContext {
  webhookId: string;
  topic: WebhookTopic;
  shopDomain: string;
  payload: unknown;
}

export type WebhookHandler = (context: WebhookContext) => Promise<void>;

export interface ShopifyService {
  readonly admin: ShopifyAdminClient;
  registerWebhookHandler(topic: WebhookTopic, handler: WebhookHandler): void;
}

// Runs on app/uninstalled after the shop is marked uninstalled and its sessions are revoked
// (for example queue.cancelByShop). The shop record is the post-uninstall state.
export type UninstallHook = (shop: ShopRecord) => Promise<void>;
// Runs on shop/redact before the auth data and the shop document are deleted. Must delete the
// shop's documents in the hook owner's collections.
export type RedactHook = (shopId: string) => Promise<void>;

export interface ShopifyHooks {
  registerUninstallHook(hook: UninstallHook): void;
  registerRedactHook(hook: RedactHook): void;
}

export interface ShopifyModuleDeps {
  env: Pick<Env, 'SHOPIFY_API_SECRET' | 'SHOPIFY_API_VERSION'>;
  logger: Logger;
  shops: ShopsInternalService;
  auth: Pick<AuthService, 'revokeAllSessions' | 'purgeShop'>;
  fetchImpl?: typeof fetch;
  // Replaces the real-time wait between THROTTLED retries (tests).
  sleep?: (ms: number) => Promise<void>;
  now?: () => Date;
}

export interface ShopifyModule {
  service: ShopifyService & ShopifyHooks;
  // Mount at the app root BEFORE express.json: it brings its own raw body parser for POST /webhooks/shopify.
  webhookRouter: Router;
}

export function createShopifyModule(deps: ShopifyModuleDeps): ShopifyModule {
  const registry: WebhookRegistry = { uninstallHooks: [], redactHooks: [], handlers: new Map() };

  const service: ShopifyService & ShopifyHooks = {
    admin: createAdminClient({
      env: deps.env,
      logger: deps.logger,
      shops: deps.shops,
      fetchImpl: deps.fetchImpl,
      sleep: deps.sleep,
    }),
    registerWebhookHandler(topic, handler) {
      registry.handlers.set(topic, [...(registry.handlers.get(topic) ?? []), handler]);
    },
    registerUninstallHook(hook) {
      registry.uninstallHooks.push(hook);
    },
    registerRedactHook(hook) {
      registry.redactHooks.push(hook);
    },
  };

  const webhookRouter = createWebhookRouter({
    env: deps.env,
    logger: deps.logger,
    shops: deps.shops,
    auth: deps.auth,
    registry,
    now: deps.now,
  });

  return { service, webhookRouter };
}
