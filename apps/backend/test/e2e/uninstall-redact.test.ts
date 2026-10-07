import mongoose from 'mongoose';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { batchSummarySchema, type MediaObject } from '@rs/shared';
import { FAKE_JPEG } from '../../src/modules/ai/fake-media';
import { BatchItemModel, BatchModel } from '../../src/modules/batches/models';
import { SessionModel } from '../../src/modules/auth/models';
import { JobModel } from '../../src/modules/queue/models';
import { ShopModel } from '../../src/modules/shops/model';
import { WebhookEventModel } from '../../src/modules/shopify/webhook-events';
import { commonImageSpec, createBatch, defined, errorOf, getBatch, login, sendWebhook, uploadReadyReferences, type ApiClient } from './support/client';
import { MONGO_START_TIMEOUT_MS, startE2e, type E2e } from './support/harness';

const GONE = 'gone-store.myshopify.com';
const STAYS = 'stays-store.myshopify.com';

let e2e: E2e;
let gone: ApiClient;
let stays: ApiClient;
const batches: { done: string; midway: string; untouched: string } = { done: '', midway: '', untouched: '' };
let staysBatch = '';
let staysReference: MediaObject;

beforeAll(async () => {
  e2e = await startE2e({ dbName: 'rs_e2e_webhooks' });
  e2e.stub.addShop(GONE);
  e2e.stub.addShop(STAYS);
  gone = await login(e2e, GONE);
  stays = await login(e2e, STAYS, { user: { id: 4242, email: 'stays@example.com' } });
}, MONGO_START_TIMEOUT_MS);

afterAll(async () => {
  await e2e.stop();
});

async function seed(client: ApiClient, productIndex: number, reference: MediaObject): Promise<string> {
  const products = e2e.stub.shop(client.shopDomain).products;
  const res = await createBatch(client, { products: [{ productGid: defined(products[productIndex]).id }], commonReferenceMediaIds: [reference.id] });
  expect(res.status).toBe(201);
  return batchSummarySchema.parse(res.body).id;
}

// Every document, in every collection, that mentions the shop by id or domain.
async function footprint(client: ApiClient): Promise<Record<string, number>> {
  const needles = [client.session.shop.id, client.shopDomain];
  const found: Record<string, number> = {};
  for (const collection of await defined(mongoose.connection.db).collections()) {
    const docs = await collection.find({}).toArray();
    const matching = docs.filter((doc) => needles.some((needle) => JSON.stringify(doc).includes(needle)));
    if (matching.length > 0) found[collection.collectionName] = matching.length;
  }
  return found;
}

const unfinished = (shopId: string) => JobModel.countDocuments({ shopId, status: { $in: ['blocked', 'queued', 'running', 'awaiting_operation'] } });

describe('before the uninstall', () => {
  it('has a finished batch, a half-processed batch and an untouched batch', async () => {
    const [reference] = await uploadReadyReferences(gone, [commonImageSpec('gone-ref', FAKE_JPEG)]);
    batches.done = await seed(gone, 0, defined(reference));
    expect((await e2e.driveBatch(batches.done, { timeoutMs: 60_000 })).status).toBe('completed');
    await e2e.settle();

    batches.midway = await seed(gone, 1, defined(reference));
    batches.untouched = await seed(gone, 2, defined(reference));
    // One tick runs the plan jobs of the two open batches; their images and videos wait in the queue.
    await e2e.tick();
    await e2e.settle();
    const midway = await getBatch(gone, batches.midway);
    expect(midway.items[0]?.jobs.map((job) => job.status)).toEqual(['succeeded', 'queued', 'queued', 'queued']);

    staysReference = defined((await uploadReadyReferences(stays, [commonImageSpec('stays-ref', FAKE_JPEG)]))[0]);

    const mine = await footprint(gone);
    expect(Object.keys(mine).sort()).toEqual(['batch_items', 'batches', 'jobs', 'login_codes', 'media_assets', 'oauth_states', 'sessions', 'shops', 'users']);
  }, 90_000);
});

describe('webhook delivery', () => {
  it('verifies the signature and the headers', async () => {
    expect((await sendWebhook(e2e, { topic: 'app/uninstalled', shop: GONE, secret: 'wrong-secret' })).status).toBe(401);
    const noHeaders = await request(e2e.app).post('/webhooks/shopify').set('content-type', 'application/json').send('{}');
    expect(noHeaders.status).toBe(401);
    const badDomain = await sendWebhook(e2e, { topic: 'app/uninstalled', shop: 'evil.example.com' });
    expect(badDomain.status).toBe(400);
    expect(errorOf(badDomain).code).toBe('validation_failed');
    // Nothing happened to the shop.
    expect((await ShopModel.findOne({ shopDomain: GONE }).lean())?.status).toBe('active');
    expect(await WebhookEventModel.countDocuments()).toBe(0);
  });

  it('acknowledges compliance topics without touching data and ignores unknown topics', async () => {
    const before = await footprint(gone);
    for (const topic of ['customers/data_request', 'customers/redact']) {
      expect((await sendWebhook(e2e, { topic, shop: GONE, payload: { shop_domain: GONE, customer: { id: 1 } } })).status).toBe(200);
    }
    expect((await sendWebhook(e2e, { topic: 'products/update', shop: GONE })).status).toBe(200);
    expect(await footprint(gone)).toEqual({ ...before, webhook_events: 2 });
    await WebhookEventModel.deleteMany({});
  });
});

describe('app/uninstalled', () => {
  it('marks the shop uninstalled, revokes the sessions and cancels the open batches', async () => {
    const delivery = await sendWebhook(e2e, { topic: 'app/uninstalled', shop: GONE, id: 'wh-uninstall-1' });
    expect(delivery.status).toBe(200);
    e2e.stub.revokeTokens(GONE);

    const shop = defined(await ShopModel.findOne({ shopDomain: GONE }).lean());
    expect(shop).toMatchObject({ status: 'uninstalled', scopes: [] });
    expect(shop.offlineToken).toBeUndefined();
    expect(shop.uninstalledAt).toBeInstanceOf(Date);
    const redactIn = (shop.redactAfter?.getTime() ?? 0) - Date.now();
    expect(redactIn).toBeGreaterThan(47.9 * 3_600_000);
    expect(redactIn).toBeLessThanOrEqual(48 * 3_600_000);
    expect((await SessionModel.find({ shopId: shop._id }).lean()).every((session) => session.revokedAt instanceof Date)).toBe(true);

    expect(await unfinished(String(shop._id))).toBe(0);
    const statuses = await BatchModel.find({ shopId: shop._id }).sort({ createdAt: 1, _id: 1 }).lean();
    expect(statuses.map((batch) => batch.status)).toEqual(['completed', 'cancelled', 'cancelled']);
    expect(statuses[1]?.cancelRequestedAt).toBeInstanceOf(Date);
    const midwayJobs = await JobModel.find({ batchId: batches.midway }).sort({ createdAt: 1 }).lean();
    expect(midwayJobs.map((job) => job.status)).toEqual(['succeeded', 'cancelled', 'cancelled', 'cancelled']);
    expect((await BatchItemModel.find({ batchId: batches.untouched }).lean()).map((item) => item.status)).toEqual(['cancelled']);

    // Nothing more is generated or uploaded for a shop that left.
    const calls = e2e.stub.state.calls.length;
    for (let tick = 0; tick < 5; tick += 1) await e2e.tick();
    await e2e.settle();
    expect(e2e.stub.state.calls.length).toBe(calls);
  });

  it('answers 409 or 401 to the old sessions', async () => {
    const me = await gone.get('/api/v1/me');
    expect(me.status).toBe(409);
    expect(errorOf(me).code).toBe('shop_reauth_required');
    expect((await gone.get('/api/v1/products')).status).toBe(409);
    expect((await gone.get(`/api/v1/batches/${batches.done}`)).status).toBe(409);
    expect((await createBatch(gone, { products: [] })).status).toBe(409);
    const refreshed = await request(e2e.app).post('/api/v1/auth/refresh').send({ refreshToken: gone.session.refreshToken });
    expect(refreshed.status).toBe(401);
  });

  it('ignores a redelivery and does not move the redact date', async () => {
    const before = defined(await ShopModel.findOne({ shopDomain: GONE }).lean());
    expect((await sendWebhook(e2e, { topic: 'app/uninstalled', shop: GONE, id: 'wh-uninstall-1' })).status).toBe(200);
    expect((await sendWebhook(e2e, { topic: 'app/uninstalled', shop: GONE, id: 'wh-uninstall-2' })).status).toBe(200);
    const after = defined(await ShopModel.findOne({ shopDomain: GONE }).lean());
    expect(after.redactAfter).toEqual(before.redactAfter);
    expect(after.uninstalledAt).toEqual(before.uninstalledAt);
    expect(await WebhookEventModel.countDocuments({ _id: /^wh-uninstall/ })).toBe(2);
    expect((await WebhookEventModel.findById('wh-uninstall-1').lean())?.processedAt).toBeInstanceOf(Date);
  });

  it('does not touch another shop, which keeps generating', async () => {
    expect((await ShopModel.findOne({ shopDomain: STAYS }).lean())?.status).toBe('active');
    expect((await stays.get('/api/v1/me')).status).toBe(200);
    staysBatch = await seed(stays, 0, staysReference);
    expect((await e2e.driveBatch(staysBatch, { timeoutMs: 60_000 })).status).toBe('completed');
    await e2e.settle();
    expect((await getBatch(stays, staysBatch)).counts).toMatchObject({ jobsSucceeded: 4, imagesReady: 2, videosReady: 1 });
  }, 90_000);

  it('brings the shop back when the merchant installs again', async () => {
    const reinstalled = await login(e2e, GONE);
    const shop = defined(await ShopModel.findOne({ shopDomain: GONE }).lean());
    expect(shop.status).toBe('active');
    expect(shop.redactAfter).toBeUndefined();
    expect(shop.uninstalledAt).toBeUndefined();
    expect(reinstalled.session.shop.id).toBe(gone.session.shop.id);
    expect((await reinstalled.get('/api/v1/products?limit=1')).status).toBe(200);
    // History survives the reinstall, still cancelled.
    expect((await getBatch(reinstalled, batches.midway)).status).toBe('cancelled');
    expect((await getBatch(reinstalled, batches.done)).status).toBe('completed');
    gone = reinstalled;
  });
});

describe('shop/redact', () => {
  it('purges every collection for the shop and leaves the other shop alone', async () => {
    // Leave and come back later: the merchant uninstalls, and 48 hours on Shopify sends shop/redact.
    expect((await sendWebhook(e2e, { topic: 'app/uninstalled', shop: GONE, id: 'wh-uninstall-3' })).status).toBe(200);
    const before = await footprint(gone);
    const staysBefore = await footprint(stays);
    expect(Object.keys(before).sort()).toEqual(['batch_items', 'batches', 'jobs', 'login_codes', 'media_assets', 'oauth_states', 'sessions', 'shops', 'users', 'webhook_events']);
    // The reference plus the three outputs of the finished batch.
    expect(before.media_assets).toBe(4);

    const redact = await sendWebhook(e2e, { topic: 'shop/redact', shop: GONE, id: 'wh-redact-1', payload: { shop_id: 1, shop_domain: GONE } });
    expect(redact.status).toBe(200);

    // Only the 7 day idempotency ledger of webhook ids (topic and domain, no tenant data) remains.
    expect(await footprint(gone)).toEqual({ webhook_events: 4 });
    expect(await footprint(stays)).toEqual(staysBefore);
    expect(await ShopModel.countDocuments({ shopDomain: GONE })).toBe(0);
    expect((await stays.get('/api/v1/me')).status).toBe(200);
    expect((await getBatch(stays, staysBatch)).counts.jobsSucceeded).toBe(4);

    // The old tokens lead nowhere.
    expect((await gone.get('/api/v1/me')).status).toBe(409);
    const refreshed = await request(e2e.app).post('/api/v1/auth/refresh').send({ refreshToken: gone.session.refreshToken });
    expect(refreshed.status).toBe(401);

    // A redelivery, or a second redact, is a no-op.
    expect((await sendWebhook(e2e, { topic: 'shop/redact', shop: GONE, id: 'wh-redact-1' })).status).toBe(200);
    expect((await sendWebhook(e2e, { topic: 'shop/redact', shop: GONE, id: 'wh-redact-2' })).status).toBe(200);
    expect(await footprint(gone)).toEqual({ webhook_events: 5 });
  });

});

describe('uninstall while jobs are running', () => {
  it('cancels the batch and lets the running jobs end without errors', async () => {
    const batchId = await seed(stays, 1, staysReference);
    await e2e.drive(async () => (await JobModel.countDocuments({ batchId, type: 'image', status: 'running' })) > 0, { timeoutMs: 30_000 });
    expect((await sendWebhook(e2e, { topic: 'app/uninstalled', shop: STAYS, id: 'wh-uninstall-busy' })).status).toBe(200);
    await e2e.settle();

    expect(await unfinished(stays.session.shop.id)).toBe(0);
    expect((await BatchModel.findById(batchId).lean())?.status).toBe('cancelled');
    const jobs = await JobModel.find({ batchId }).lean();
    expect(jobs.every((job) => job.status === 'succeeded' || job.status === 'cancelled')).toBe(true);
    expect(jobs.some((job) => job.status === 'cancelled')).toBe(true);
    expect((await stays.get('/api/v1/me')).status).toBe(409);
  }, 90_000);

  it('logged only the expected warnings', () => {
    const expected = [
      'ignoring webhook for an unsubscribed topic',
      'released blocked jobs whose dependencies were already terminal',
      'outcome dropped: the job is no longer owned by this runner',
      'persisting an output failed',
      'fileStatus poll failed',
    ];
    expect(e2e.problems(expected)).toEqual([]);
  });
});
