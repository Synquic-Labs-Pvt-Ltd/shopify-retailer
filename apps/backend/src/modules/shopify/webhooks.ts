import express, { Router } from 'express';
import { WEBHOOK_TOPICS, isValidShopDomain, type WebhookTopic } from '@rs/shared';
import { AppError } from '../../core/errors';
import type { Env } from '../../core/env';
import type { Logger } from '../../core/logger';
import type { AuthService } from '../auth';
import type { ShopsInternalService } from '../shops';
import { verifyWebhookHmac } from './hmac';
import type { RedactHook, UninstallHook, WebhookContext, WebhookHandler } from './index';
import { WEBHOOK_EVENT_TTL_MS, WebhookEventModel } from './webhook-events';

// An unprocessed event younger than this is treated as in flight on another request.
export const WEBHOOK_LEASE_MS = 60_000;

export interface WebhookRegistry {
  uninstallHooks: UninstallHook[];
  redactHooks: RedactHook[];
  handlers: Map<WebhookTopic, WebhookHandler[]>;
}

export interface WebhookRouterDeps {
  env: Pick<Env, 'SHOPIFY_API_SECRET'>;
  logger: Logger;
  shops: Pick<ShopsInternalService, 'getByDomain' | 'markUninstalled' | 'purgeShop'>;
  auth: Pick<AuthService, 'revokeAllSessions' | 'purgeShop'>;
  registry: WebhookRegistry;
  now?: () => Date;
}

function isWebhookTopic(value: string): value is WebhookTopic {
  return (WEBHOOK_TOPICS as readonly string[]).includes(value);
}

function isDuplicateKey(err: unknown): boolean {
  return typeof err === 'object' && err !== null && 'code' in err && err.code === 11000;
}

// Runs every task even when one fails, then reports the failures together.
async function runAll(label: string, tasks: Array<() => Promise<void>>): Promise<void> {
  const failures: unknown[] = [];
  for (const task of tasks) {
    try {
      await task();
    } catch (err) {
      failures.push(err);
    }
  }
  if (failures.length > 0) throw new AggregateError(failures, `${label}: ${failures.length} step(s) failed`);
}

export function createWebhookRouter(deps: WebhookRouterDeps): Router {
  const { env, logger, shops, auth, registry } = deps;
  const now = deps.now ?? (() => new Date());

  // Returns true when this request should process the event.
  const claim = async (webhookId: string, topic: string, shopDomain: string): Promise<'process' | 'duplicate' | 'in_flight'> => {
    const receivedAt = now();
    try {
      await WebhookEventModel.create({
        _id: webhookId,
        topic,
        shopDomain,
        receivedAt,
        expiresAt: new Date(receivedAt.getTime() + WEBHOOK_EVENT_TTL_MS),
      });
      return 'process';
    } catch (err) {
      if (!isDuplicateKey(err)) throw err;
    }

    // A previous attempt died without finishing: take it over once its lease ran out.
    const takenOver = await WebhookEventModel.findOneAndUpdate(
      { _id: webhookId, processedAt: null, receivedAt: { $lte: new Date(receivedAt.getTime() - WEBHOOK_LEASE_MS) } },
      { $set: { receivedAt } },
    ).lean();
    if (takenOver !== null) return 'process';

    const existing = await WebhookEventModel.findById(webhookId).lean();
    return existing?.processedAt ? 'duplicate' : 'in_flight';
  };

  const handleUninstalled = async (shopDomain: string): Promise<void> => {
    const shop = await shops.markUninstalled(shopDomain);
    if (shop === null) return;
    await auth.revokeAllSessions(shop.id);
    await runAll('uninstall hooks', registry.uninstallHooks.map((hook) => () => hook(shop)));
  };

  const handleShopRedact = async (shopDomain: string): Promise<void> => {
    const shop = await shops.getByDomain(shopDomain);
    if (shop === null) return;
    // Other modules purge first; the shop document goes last because auth looks up its domain.
    await runAll('redact hooks', registry.redactHooks.map((hook) => () => hook(shop.id)));
    await auth.purgeShop(shop.id);
    await shops.purgeShop(shop.id);
  };

  const dispatch = async (context: WebhookContext): Promise<void> => {
    switch (context.topic) {
      case 'app/uninstalled':
        await handleUninstalled(context.shopDomain);
        break;
      case 'shop/redact':
        await handleShopRedact(context.shopDomain);
        break;
      case 'customers/data_request':
      case 'customers/redact':
        // We store no customer data (SPEC 8.4): acknowledge only.
        logger.info({ topic: context.topic, shopDomain: context.shopDomain }, 'compliance webhook acknowledged');
        break;
    }
    const extra = registry.handlers.get(context.topic) ?? [];
    await runAll(`${context.topic} handlers`, extra.map((handler) => () => handler(context)));
  };

  const router = Router();

  router.post('/webhooks/shopify', express.raw({ type: '*/*', limit: '1mb' }), async (req, res) => {
    const body: unknown = req.body;
    if (!Buffer.isBuffer(body)) throw AppError.validation('Expected a raw request body');

    const signature = req.header('x-shopify-hmac-sha256');
    if (signature === undefined || !verifyWebhookHmac(body, signature, env.SHOPIFY_API_SECRET)) {
      throw AppError.unauthorized('Invalid webhook signature');
    }

    const webhookId = req.header('x-shopify-webhook-id');
    const topic = req.header('x-shopify-topic');
    const shopDomain = req.header('x-shopify-shop-domain')?.toLowerCase();
    if (!webhookId || !topic || !shopDomain || !isValidShopDomain(shopDomain)) {
      throw AppError.validation('Missing or invalid Shopify webhook headers');
    }
    if (!isWebhookTopic(topic)) {
      logger.warn({ topic, shopDomain }, 'ignoring webhook for an unsubscribed topic');
      res.sendStatus(200);
      return;
    }

    let payload: unknown;
    try {
      payload = JSON.parse(body.toString('utf8'));
    } catch {
      throw AppError.validation('Webhook body is not valid JSON');
    }

    const claimed = await claim(webhookId, topic, shopDomain);
    if (claimed === 'duplicate') {
      logger.info({ webhookId, topic }, 'duplicate webhook ignored');
      res.sendStatus(200);
      return;
    }
    if (claimed === 'in_flight') {
      // Non-2xx makes Shopify redeliver later, when the first attempt has settled.
      throw new AppError('internal', 'Webhook is being processed', { status: 503 });
    }

    try {
      await dispatch({ webhookId, topic, shopDomain, payload });
    } catch (err) {
      logger.error({ err, webhookId, topic, shopDomain }, 'webhook processing failed');
      // Forget the event so Shopify's retry is processed from scratch.
      await WebhookEventModel.deleteOne({ _id: webhookId, processedAt: null });
      throw AppError.internal('Webhook processing failed', err);
    }
    await WebhookEventModel.updateOne({ _id: webhookId }, { $set: { processedAt: now() } });
    logger.info({ webhookId, topic, shopDomain }, 'webhook processed');
    res.sendStatus(200);
  });

  return router;
}
