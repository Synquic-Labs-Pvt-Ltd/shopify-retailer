import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { attachMediaResponseSchema } from '@rs/shared';
import { MONGO_START_TIMEOUT_MS, startTestMongo, type TestMongo } from '../helpers/mongo';
import { createKit, prepareIndexes, SHOP_B, type Kit } from './kit';

let mongo: TestMongo;
let kit: Kit;

beforeAll(async () => {
  mongo = await startTestMongo('rs_batches_attach');
}, MONGO_START_TIMEOUT_MS);

afterAll(async () => {
  await mongo.stop();
});

beforeEach(async () => {
  await mongo.clear();
  kit = createKit();
  await prepareIndexes(kit);
});

async function finishedBatch(products: number) {
  const common = kit.reference();
  const summary = await kit.create({ products: kit.products(products).map((productGid) => ({ productGid })), commonReferenceMediaIds: [common] });
  const detail = await kit.driveToTerminal(summary.id);
  return detail;
}

describe('POST /batches/:id/attach-media', () => {
  it('adds the outputs of every item to the product the item was made for', async () => {
    const detail = await finishedBatch(2);

    const res = await kit.api().post(`/batches/${detail.id}/attach-media`);

    expect(res.status).toBe(200);
    const body = attachMediaResponseSchema.parse(res.body);
    expect(body).toMatchObject({ attached: 6, alreadyAttached: 0, failed: 0 });
    expect(body.items.map((row) => row.productGid).sort()).toEqual(detail.items.map((item) => item.productGid).sort());
    const [targets] = kit.media.attachCalls;
    for (const item of detail.items) {
      expect(targets?.find((target) => target.productGid === item.productGid)?.mediaIds.sort()).toEqual(item.outputs.map((media) => media.id).sort());
    }
  });

  it('can be limited to some items', async () => {
    const detail = await finishedBatch(3);
    const [first] = detail.items;

    const res = await kit.api().post(`/batches/${detail.id}/attach-media`).send({ itemIds: [first?.id] });

    expect(res.status).toBe(200);
    expect(attachMediaResponseSchema.parse(res.body).items.map((row) => row.itemId)).toEqual([first?.id]);
    expect(kit.media.attachCalls[0]).toHaveLength(1);
  });

  it('skips items that have no outputs yet', async () => {
    const common = kit.reference();
    const summary = await kit.create({ products: kit.products(1).map((productGid) => ({ productGid })), commonReferenceMediaIds: [common] });

    const res = await kit.api().post(`/batches/${summary.id}/attach-media`);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ items: [], attached: 0, alreadyAttached: 0, failed: 0 });
  });

  it('answers 404 for a batch or an item of another shop, and 400 for malformed ids', async () => {
    const detail = await finishedBatch(1);

    expect((await kit.api(SHOP_B).post(`/batches/${detail.id}/attach-media`)).status).toBe(404);
    expect((await kit.api().post('/batches/not-an-id/attach-media')).status).toBe(400);
    expect((await kit.api().post(`/batches/${detail.id}/attach-media`).send({ itemIds: ['x'.repeat(24)] })).status).toBe(400);
    const missing = 'a'.repeat(24);
    expect((await kit.api().post(`/batches/${detail.id}/attach-media`).send({ itemIds: [missing] })).status).toBe(404);
    expect(kit.media.attachCalls).toHaveLength(0);
  });
});
