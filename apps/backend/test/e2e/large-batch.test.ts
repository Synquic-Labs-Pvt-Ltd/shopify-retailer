import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { batchSummarySchema, type MediaObject } from '@rs/shared';
import { FAKE_JPEG } from '../../src/modules/ai/fake-media';
import { BatchItemModel } from '../../src/modules/batches/models';
import { JobModel } from '../../src/modules/queue/models';
import { commonImageSpec, createBatch, defined, errorOf, getBatch, login, uploadReadyReferences, type ApiClient } from './support/client';
import { MONGO_START_TIMEOUT_MS, startE2e, type E2e } from './support/harness';
import type { ProductSeed } from './support/shopify-stub';

const SHOP = 'bulk-store.myshopify.com';

let e2e: E2e;
let client: ApiClient;
let reference: MediaObject;
let gids: string[] = [];

beforeAll(async () => {
  e2e = await startE2e({ dbName: 'rs_e2e_bulk' });
  const seeds: ProductSeed[] = Array.from({ length: 51 }, (_unused, index) => ({ title: `Bulk Product ${index + 1}`, handle: `bulk-product-${index + 1}`, images: 2 }));
  e2e.stub.addShop(SHOP, seeds);
  client = await login(e2e, SHOP);
  gids = e2e.stub.shop(SHOP).products.map((product) => product.id);
  reference = defined((await uploadReadyReferences(client, [commonImageSpec('common', FAKE_JPEG)]))[0]);
}, MONGO_START_TIMEOUT_MS);

afterAll(async () => {
  await e2e.stop();
});

const body = (count: number) => ({ products: gids.slice(0, count).map((productGid) => ({ productGid })), commonReferenceMediaIds: [reference.id] });

describe('a batch of the maximum size', () => {
  it('refuses 51 products and accepts 50', async () => {
    const tooMany = await createBatch(client, body(51));
    expect(tooMany.status).toBe(429);
    expect(errorOf(tooMany).code).toBe('shop_limit');
    expect(e2e.stub.graphqlOperations(SHOP)).not.toContain('ProductSnapshots');
  });

  it('snapshots the products in chunks, creates every job and generates all 150 outputs', async () => {
    const res = await createBatch(client, body(50));
    expect(res.status).toBe(201);
    const summary = batchSummarySchema.parse(res.body);
    expect(summary.counts).toMatchObject({ products: 50, jobsTotal: 200 });
    // 50 gids go to Shopify in chunks of 20.
    expect(e2e.stub.graphqlOperations(SHOP).filter((operation) => operation === 'ProductSnapshots')).toHaveLength(3);
    expect(await JobModel.countDocuments({ batchId: summary.id })).toBe(200);
    expect(await BatchItemModel.countDocuments({ batchId: summary.id })).toBe(50);

    const batch = await e2e.driveBatch(summary.id, { timeoutMs: 120_000, intervalMs: 50 });
    expect(batch.status).toBe('completed');
    await e2e.settle();

    const detail = await getBatch(client, summary.id);
    expect(detail.counts).toMatchObject({ jobsSucceeded: 200, jobsFailed: 0, imagesReady: 100, videosReady: 50 });
    expect(detail.items).toHaveLength(50);
    expect(detail.items.every((item) => item.status === 'completed' && item.outputs.length === 3)).toBe(true);
    expect(detail.items.map((item) => item.productGid)).toEqual(gids.slice(0, 50));
    const jobs = await JobModel.find({ batchId: summary.id }).lean();
    expect(jobs.every((job) => job.attempts === 1 && job.deferrals === 0)).toBe(true);
    expect(e2e.stub.shop(SHOP).files.size).toBe(1 + 150);
    expect(e2e.problems(['released blocked jobs whose dependencies were already terminal'])).toEqual([]);
  }, 180_000);
});
