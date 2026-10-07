import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { mediaListResponseSchema, mediaObjectSchema, uploadsResponseSchema } from '@rs/shared';
import { MediaAssetModel } from '../../src/modules/media/models';
import { createTestApp, fakeRequireAuth } from '../catalog/kit';
import { MONGO_START_TIMEOUT_MS, startTestMongo, type TestMongo } from '../helpers/mongo';
import { createKit, imageFile, newObjectId, OTHER_SHOP_ID, SHOP_ID, videoFile, type MediaKit } from './kit';

let mongo: TestMongo;
let kit: MediaKit;
let inUse = false;

beforeAll(async () => {
  mongo = await startTestMongo();
  await MediaAssetModel.createIndexes();
}, MONGO_START_TIMEOUT_MS);

afterAll(async () => {
  await mongo.stop();
});

beforeEach(async () => {
  await mongo.clear();
  inUse = false;
  kit = createKit({ requireAuth: fakeRequireAuth, isMediaInUse: () => Promise.resolve(inUse) });
});

function app() {
  return createTestApp((instance) => instance.use('/api/v1', kit.media.router));
}

const asShop = (shopId = SHOP_ID) => ({ 'x-test-shop': shopId });

async function uploadViaApi(files = [imageFile('one')], shopId = SHOP_ID) {
  const response = await request(app()).post('/api/v1/media/uploads').set(asShop(shopId)).send({ files });
  expect(response.status).toBe(200);
  return uploadsResponseSchema.parse(response.body).targets;
}

describe('media routes', () => {
  it('require authentication', async () => {
    const id = newObjectId();
    const calls = [
      request(app()).post('/api/v1/media/uploads').send({ files: [] }),
      request(app()).post(`/api/v1/media/${id}/complete`),
      request(app()).get(`/api/v1/media?ids=${id}`),
      request(app()).delete(`/api/v1/media/${id}`),
    ];
    for (const response of await Promise.all(calls)) expect(response.status).toBe(401);
    expect(kit.shopify.calls).toHaveLength(0);
  });

  it('runs the reference flow over HTTP: uploads, complete, lazy refresh to ready for an image and a video', async () => {
    const targets = await uploadViaApi([imageFile('img'), videoFile('vid', { scope: 'product', productGid: 'gid://shopify/Product/5' })]);
    expect(targets.map((target) => target.clientId)).toEqual(['img', 'vid']);
    const ids = targets.map((target) => target.mediaId);

    for (const id of ids) {
      const response = await request(app()).post(`/api/v1/media/${id}/complete`).set(asShop());
      expect(response.status).toBe(200);
      expect(mediaObjectSchema.parse(response.body).status).toBe('processing');
    }

    const processing = await request(app()).get(`/api/v1/media?ids=${ids.join(',')}`).set(asShop());
    expect(processing.status).toBe(200);
    expect(mediaListResponseSchema.parse(processing.body).items.map((item) => item.status)).toEqual(['processing', 'processing']);

    for (const gid of kit.shopify.gids()) kit.shopify.setReady(gid);
    kit.clock.advance(3_000);
    const ready = await request(app()).get(`/api/v1/media?ids=${ids.join(',')}`).set(asShop());

    const items = mediaListResponseSchema.parse(ready.body).items;
    expect(items.map((item) => [item.id, item.mediaType, item.status])).toEqual([
      [ids[0], 'image', 'ready'],
      [ids[1], 'video', 'ready'],
    ]);
    expect(items[0]).toMatchObject({ url: expect.any(String), width: 1536, height: 2048, scope: 'common' });
    expect(items[1]).toMatchObject({ url: expect.stringMatching(/\.mp4$/), durationSec: 8, scope: 'product', productGid: 'gid://shopify/Product/5' });
  });

  it('validates the upload body with the shared schema and the limits with the config', async () => {
    const noFiles = await request(app()).post('/api/v1/media/uploads').set(asShop()).send({ files: [] });
    const productWithoutGid = await request(app())
      .post('/api/v1/media/uploads')
      .set(asShop())
      .send({ files: [imageFile('a', { scope: 'product' })] });
    const badMime = await request(app())
      .post('/api/v1/media/uploads')
      .set(asShop())
      .send({ files: [imageFile('a', { mimeType: 'image/gif' })] });

    expect(noFiles.status).toBe(400);
    expect(productWithoutGid.status).toBe(400);
    expect(badMime.status).toBe(400);
    expect(badMime.body.error).toMatchObject({
      code: 'validation_failed',
      details: { files: [expect.objectContaining({ clientId: 'a', code: 'unsupported_mime_type' })] },
    });
    expect(kit.shopify.calls).toHaveLength(0);
  });

  it('validates ids in the path and in the query', async () => {
    const complete = await request(app()).post('/api/v1/media/not-an-id/complete').set(asShop());
    const missingIds = await request(app()).get('/api/v1/media').set(asShop());
    const tooMany = await request(app())
      .get(`/api/v1/media?ids=${Array.from({ length: 51 }, () => newObjectId()).join(',')}`)
      .set(asShop());
    const junk = await request(app()).get('/api/v1/media?ids=abc').set(asShop());

    expect([complete.status, missingIds.status, tooMany.status, junk.status]).toEqual([400, 400, 400, 400]);
  });

  it('never exposes the assets of another shop', async () => {
    const [target] = await uploadViaApi();
    const id = target?.mediaId ?? '';

    const list = await request(app()).get(`/api/v1/media?ids=${id}`).set(asShop(OTHER_SHOP_ID));
    const complete = await request(app()).post(`/api/v1/media/${id}/complete`).set(asShop(OTHER_SHOP_ID));
    const remove = await request(app()).delete(`/api/v1/media/${id}`).set(asShop(OTHER_SHOP_ID));

    expect(list.status).toBe(200);
    expect(list.body).toEqual({ items: [] });
    expect(complete.status).toBe(404);
    expect(remove.status).toBe(404);
    expect(kit.shopify.count('FileCreate')).toBe(0);
    expect(kit.shopify.count('FileDelete')).toBe(0);
    expect((await MediaAssetModel.findById(id).lean())?.status).toBe('awaiting_upload');
  });

  it('answers 404 for an unknown asset', async () => {
    const complete = await request(app()).post(`/api/v1/media/${newObjectId()}/complete`).set(asShop());
    const remove = await request(app()).delete(`/api/v1/media/${newObjectId()}`).set(asShop());

    expect(complete.status).toBe(404);
    expect(complete.body.error.code).toBe('not_found');
    expect(remove.status).toBe(404);
  });

  it('deletes with 204, and answers 409 in_use while a batch uses the reference', async () => {
    const [target] = await uploadViaApi();
    const id = target?.mediaId ?? '';
    await request(app()).post(`/api/v1/media/${id}/complete`).set(asShop());

    inUse = true;
    const blocked = await request(app()).delete(`/api/v1/media/${id}`).set(asShop());
    expect(blocked.status).toBe(409);
    expect(blocked.body.error.code).toBe('in_use');
    expect(kit.shopify.count('FileDelete')).toBe(0);

    inUse = false;
    const deleted = await request(app()).delete(`/api/v1/media/${id}`).set(asShop());
    expect(deleted.status).toBe(204);
    expect(deleted.text).toBe('');
    expect(kit.shopify.count('FileDelete')).toBe(1);

    const list = await request(app()).get(`/api/v1/media?ids=${id}`).set(asShop());
    expect(mediaListResponseSchema.parse(list.body).items[0]?.status).toBe('deleted');
  });

  it('does not delete outputs', async () => {
    const output = await MediaAssetModel.create({
      shopId: SHOP_ID,
      role: 'output',
      mediaType: 'image',
      status: 'ready',
      filename: 'out.jpg',
      mimeType: 'image/jpeg',
      fileSize: 1,
    });

    const response = await request(app()).delete(`/api/v1/media/${output._id.toHexString()}`).set(asShop());

    expect(response.status).toBe(403);
    expect(kit.shopify.count('FileDelete')).toBe(0);
  });
});
