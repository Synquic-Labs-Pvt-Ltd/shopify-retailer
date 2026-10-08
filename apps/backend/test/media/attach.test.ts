import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { mediaObjectSchema } from '@rs/shared';
import { AppError } from '../../src/core/errors';
import type { PersistOutputInput } from '../../src/modules/media';
import { ATTACH_DENIED_MESSAGE } from '../../src/modules/media/attach';
import { MediaAssetModel } from '../../src/modules/media/models';
import { MONGO_START_TIMEOUT_MS, startTestMongo, type TestMongo } from '../helpers/mongo';
import { createKit, newObjectId, SHOP_ID, USER_ID, OTHER_SHOP_ID, type MediaKit } from './kit';

let mongo: TestMongo;
let kit: MediaKit;

beforeAll(async () => {
  mongo = await startTestMongo();
  await MediaAssetModel.createIndexes();
}, MONGO_START_TIMEOUT_MS);

afterAll(async () => {
  await mongo.stop();
});

beforeEach(async () => {
  await mongo.clear();
  kit = createKit();
  kit.shopify.defaultQueriesUntilReady = 1;
});

const PRODUCT = 'gid://shopify/Product/42';
const OTHER_PRODUCT = 'gid://shopify/Product/43';

function output(overrides: Partial<PersistOutputInput> = {}): PersistOutputInput {
  return {
    shopId: SHOP_ID,
    createdByUserId: USER_ID,
    batchId: newObjectId(),
    batchItemId: newObjectId(),
    sourceJobId: newObjectId(),
    productGid: PRODUCT,
    mediaType: 'image',
    mimeType: 'image/jpeg',
    bytes: new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4]),
    filename: `rs-lamp-${Math.random().toString(36).slice(2, 8)}-img1.jpg`,
    alt: 'Ceramic lamp: Hero',
    shotTitle: 'Hero',
    ...overrides,
  };
}

const persist = (input: PersistOutputInput) => kit.media.service.storage.persistOutput(input);
const attach = (...targets: { productGid: string; mediaIds: string[] }[]) => kit.media.service.attachToProducts(SHOP_ID, targets);

describe('attachToProducts', () => {
  it('adds the output files to the product with fileUpdate referencesToAdd and records when', async () => {
    const image = await persist(output());
    const video = await persist(output({ mediaType: 'video', mimeType: 'video/mp4', filename: 'rs-lamp-vid1.mp4', bytes: new Uint8Array(2048) }));
    const gids = kit.shopify.gids();

    const [result] = await attach({ productGid: PRODUCT, mediaIds: [image.id, video.id] });

    expect(result).toEqual({ productGid: PRODUCT, attached: [image.id, video.id], alreadyAttached: [], failed: [] });
    expect(kit.shopify.count('FileUpdate')).toBe(1);
    expect(kit.shopify.last('FileUpdate').variables).toEqual({ files: gids.map((id) => ({ id, referencesToAdd: [PRODUCT] })) });
    for (const id of gids) expect([...(kit.shopify.references.get(id) ?? [])]).toEqual([PRODUCT]);

    const [stored] = await kit.media.service.getObjects(SHOP_ID, [image.id]);
    expect(mediaObjectSchema.parse(stored)).toEqual(stored);
    expect(stored?.attachedAt).toBe(kit.clock.now().toISOString());
  });

  it('is idempotent: outputs already on the product are reported and not sent again', async () => {
    const first = await persist(output());
    const second = await persist(output());
    await attach({ productGid: PRODUCT, mediaIds: [first.id] });

    const [result] = await attach({ productGid: PRODUCT, mediaIds: [first.id, second.id] });

    expect(result).toMatchObject({ attached: [second.id], alreadyAttached: [first.id], failed: [] });
    expect(kit.shopify.count('FileUpdate')).toBe(2);
    expect(kit.shopify.last('FileUpdate').variables.files).toHaveLength(1);

    const [again] = await attach({ productGid: PRODUCT, mediaIds: [first.id, second.id] });
    expect(again).toMatchObject({ attached: [], alreadyAttached: [first.id, second.id] });
    expect(kit.shopify.count('FileUpdate')).toBe(2);
  });

  it('keeps products apart: an output of another product, a reference, an unknown id and another shop are failures', async () => {
    const mine = await persist(output());
    const forOther = await persist(output({ productGid: OTHER_PRODUCT }));
    const foreign = await persist(output({ shopId: OTHER_SHOP_ID }));
    const [reference] = await MediaAssetModel.create([
      { shopId: SHOP_ID, role: 'reference', mediaType: 'image', status: 'ready', filename: 'ref.jpg', mimeType: 'image/jpeg', fileSize: 10, shopify: { fileGid: 'gid://shopify/MediaImage/999' }, productGid: PRODUCT },
    ]);
    const unknown = newObjectId();

    const [result] = await attach({ productGid: PRODUCT, mediaIds: [mine.id, forOther.id, foreign.id, String(reference?._id), unknown] });

    expect(result?.attached).toEqual([mine.id]);
    expect(result?.failed.map((entry) => entry.mediaId).sort()).toEqual([forOther.id, foreign.id, String(reference?._id), unknown].sort());
    expect(kit.shopify.last('FileUpdate').variables.files).toHaveLength(1);
  });

  it('does not touch outputs that are not ready', async () => {
    const pending = await persist(output());
    await MediaAssetModel.updateOne({ _id: pending.id }, { $set: { status: 'processing' } });

    const [result] = await attach({ productGid: PRODUCT, mediaIds: [pending.id] });

    expect(result).toMatchObject({ attached: [], failed: [{ mediaId: pending.id, message: 'The output is not ready yet' }] });
    expect(kit.shopify.count('FileUpdate')).toBe(0);
  });

  it("reports Shopify's own refusal per output and leaves them unattached so a retry can work", async () => {
    const image = await persist(output());
    kit.shopify.fileUpdateUserErrors = [{ field: ['files', '0', 'referencesToAdd'], message: 'Product does not exist.', code: 'INVALID' }];

    const [result] = await attach({ productGid: PRODUCT, mediaIds: [image.id] });

    expect(result?.attached).toEqual([]);
    expect(result?.failed).toEqual([{ mediaId: image.id, message: 'INVALID: Product does not exist.' }]);
    expect((await kit.media.service.getObjects(SHOP_ID, [image.id]))[0]?.attachedAt).toBeNull();

    kit.shopify.fileUpdateUserErrors = [];
    expect((await attach({ productGid: PRODUCT, mediaIds: [image.id] }))[0]?.attached).toEqual([image.id]);
  });

  it('explains a denied scope instead of failing the request', async () => {
    const image = await persist(output());
    kit.shopify.denyFileUpdate = true;

    const [result] = await attach({ productGid: PRODUCT, mediaIds: [image.id] });

    expect(result?.failed).toEqual([{ mediaId: image.id, message: ATTACH_DENIED_MESSAGE }]);
  });

  it('lets a shop-level failure through (login needed, Shopify down)', async () => {
    const image = await persist(output());
    kit.shopify.failFileUpdateWith = AppError.shopReauthRequired();

    await expect(attach({ productGid: PRODUCT, mediaIds: [image.id] })).rejects.toMatchObject({ code: 'shop_reauth_required' });
    expect((await kit.media.service.getObjects(SHOP_ID, [image.id]))[0]?.attachedAt).toBeNull();
  });

  it('handles many products and keeps the results in the order of the targets', async () => {
    const targets = [];
    for (let n = 0; n < 7; n += 1) {
      const productGid = `gid://shopify/Product/${100 + n}`;
      const media = await persist(output({ productGid }));
      targets.push({ productGid, mediaIds: [media.id] });
    }

    const results = await attach(...targets);

    expect(results.map((result) => result.productGid)).toEqual(targets.map((target) => target.productGid));
    expect(results.every((result) => result.attached.length === 1)).toBe(true);
    expect(kit.shopify.count('FileUpdate')).toBe(7);
  });
});
