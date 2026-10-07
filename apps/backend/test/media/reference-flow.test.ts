import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { defaultGenerationConfig, mediaObjectSchema, uploadTargetSchema } from '@rs/shared';
import { MediaAssetModel } from '../../src/modules/media/models';
import { REFRESH_MIN_INTERVAL_MS } from '../../src/modules/media/refresh';
import { MONGO_START_TIMEOUT_MS, startTestMongo, type TestMongo } from '../helpers/mongo';
import { createKit, imageFile, newObjectId, OTHER_SHOP_ID, SHOP_ID, USER_ID, videoFile, type MediaKit } from './kit';

const actor = { shopId: SHOP_ID, userId: USER_ID };
const otherActor = { shopId: OTHER_SHOP_ID, userId: USER_ID };

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
});

async function uploadOne(file = imageFile('img')) {
  const [target] = await kit.media.service.storage.createUploadTargets(actor, [file]);
  if (target === undefined) throw new Error('no target');
  return target;
}

async function uploadAndComplete(file = imageFile('img')) {
  const target = await uploadOne(file);
  const completed = await kit.media.service.storage.completeUpload(actor, target.mediaId);
  const record = await MediaAssetModel.findById(target.mediaId).lean();
  return { target, completed, fileGid: record?.shopify?.fileGid ?? '' };
}

function refresh(ids: string[], shopId = SHOP_ID) {
  return kit.media.service.getObjects(shopId, ids, { refresh: true });
}

describe('createUploadTargets', () => {
  it('stages every file, returns the targets and records awaiting_upload assets', async () => {
    const targets = await kit.media.service.storage.createUploadTargets(actor, [
      imageFile('c1'),
      videoFile('c2', { mimeType: 'video/quicktime', fileSize: 9_000_000, durationSec: 20 }),
      imageFile('p1', { scope: 'product', productGid: 'gid://shopify/Product/9', mimeType: 'image/png', fileSize: 500 }),
    ]);

    expect(targets.map((target) => target.clientId)).toEqual(['c1', 'c2', 'p1']);
    for (const target of targets) {
      expect(uploadTargetSchema.parse(target)).toEqual(target);
      expect(target.method).toBe('POST');
      expect(target.parameters.map((parameter) => parameter.name)).toEqual(['key', 'policy']);
    }

    expect(kit.shopify.count('StagedUploadsCreate')).toBe(1);
    expect(kit.shopify.last('StagedUploadsCreate').shopId).toBe(SHOP_ID);
    const input = kit.shopify.last('StagedUploadsCreate').variables.input as Record<string, string>[];
    expect(input.map((item) => item.resource)).toEqual(['IMAGE', 'VIDEO', 'IMAGE']);
    expect(input.map((item) => item.mimeType)).toEqual(['image/jpeg', 'video/quicktime', 'image/png']);
    expect(input.map((item) => item.fileSize)).toEqual(['1000000', '9000000', '500']);
    expect(input.every((item) => item.httpMethod === 'POST')).toBe(true);
    expect(input.map((item) => item.filename)).toEqual([
      expect.stringMatching(/^rs-ref-[0-9a-f]{8}\.jpg$/),
      expect.stringMatching(/^rs-ref-[0-9a-f]{8}\.mov$/),
      expect.stringMatching(/^rs-ref-[0-9a-f]{8}\.png$/),
    ]);

    const records = await MediaAssetModel.find().lean();
    expect(records).toHaveLength(3);
    const byId = new Map(records.map((record) => [record._id.toHexString(), record]));
    const common = byId.get(targets[0]?.mediaId ?? '');
    expect(common).toMatchObject({
      role: 'reference',
      mediaType: 'image',
      storageProvider: 'shopify',
      status: 'awaiting_upload',
      scope: 'common',
      mimeType: 'image/jpeg',
      fileSize: 1_000_000,
      alt: 'Retailer Studio reference',
    });
    expect(common?.shopId.toHexString()).toBe(SHOP_ID);
    expect(common?.createdByUserId?.toHexString()).toBe(USER_ID);
    expect(common?.shopify?.stagedResourceUrl).toContain('https://staging.example/files/');
    expect(common?.shopify?.fileGid).toBeUndefined();
    expect(common?.filename).toBe(input[0]?.filename);
    expect(common?.productGid).toBeUndefined();
    expect(byId.get(targets[1]?.mediaId ?? '')).toMatchObject({ mediaType: 'video', durationSec: 20 });
    expect(byId.get(targets[2]?.mediaId ?? '')).toMatchObject({ scope: 'product', productGid: 'gid://shopify/Product/9' });
  });

  it('does not call Shopify or write anything when a file is rejected', async () => {
    const error = await kit.media.service.storage
      .createUploadTargets(actor, [imageFile('ok'), imageFile('bad', { mimeType: 'image/gif' })])
      .catch((err: unknown) => err);

    expect(error).toMatchObject({ code: 'validation_failed' });
    expect(kit.shopify.calls).toHaveLength(0);
    expect(await MediaAssetModel.countDocuments()).toBe(0);
  });

  it('writes no records when Shopify refuses the staged upload', async () => {
    kit.shopify.stagedUserErrors = [{ field: ['input', '0'], message: 'Invalid' }];

    await expect(kit.media.service.storage.createUploadTargets(actor, [imageFile('a')])).rejects.toMatchObject({ code: 'internal' });

    expect(await MediaAssetModel.countDocuments()).toBe(0);
  });

  it('reads the limits from the live config', async () => {
    const strict = { ...defaultGenerationConfig, references: { ...defaultGenerationConfig.references, maxImageMB: 1 } };
    kit = createKit({ config: strict });

    await expect(kit.media.service.storage.createUploadTargets(actor, [imageFile('big', { fileSize: 2 * 1024 * 1024 })])).rejects.toMatchObject({
      code: 'validation_failed',
    });
  });
});

describe('completeUpload', () => {
  it('creates the file from the staged resource url and moves to processing', async () => {
    const target = await uploadOne();
    const staged = await MediaAssetModel.findById(target.mediaId).lean();

    const completed = await kit.media.service.storage.completeUpload(actor, target.mediaId);

    expect(mediaObjectSchema.parse(completed)).toEqual(completed);
    expect(completed).toMatchObject({ id: target.mediaId, role: 'reference', mediaType: 'image', status: 'processing', url: null, scope: 'common' });
    const files = kit.shopify.last('FileCreate').variables.files as Record<string, string>[];
    expect(files).toEqual([
      {
        originalSource: staged?.shopify?.stagedResourceUrl,
        contentType: 'IMAGE',
        filename: staged?.filename,
        alt: 'Retailer Studio reference',
      },
    ]);
    const record = await MediaAssetModel.findById(target.mediaId).lean();
    expect(record?.status).toBe('processing');
    expect(record?.shopify?.fileGid).toMatch(/^gid:\/\/shopify\/MediaImage\/\d+$/);
  });

  it('uses contentType VIDEO for videos', async () => {
    const target = await uploadOne(videoFile('vid'));
    await kit.media.service.storage.completeUpload(actor, target.mediaId);

    expect((kit.shopify.last('FileCreate').variables.files as Record<string, string>[])[0]?.contentType).toBe('VIDEO');
  });

  it('is idempotent: a second call returns the asset without another fileCreate', async () => {
    const target = await uploadOne();
    const first = await kit.media.service.storage.completeUpload(actor, target.mediaId);
    const second = await kit.media.service.storage.completeUpload(actor, target.mediaId);

    expect(second).toEqual(first);
    expect(kit.shopify.count('FileCreate')).toBe(1);
  });

  it('only calls fileCreate once for concurrent calls', async () => {
    const target = await uploadOne();
    await Promise.all([
      kit.media.service.storage.completeUpload(actor, target.mediaId),
      kit.media.service.storage.completeUpload(actor, target.mediaId),
      kit.media.service.storage.completeUpload(actor, target.mediaId),
    ]);

    expect(kit.shopify.count('FileCreate')).toBe(1);
  });

  it('lets the app retry after a transport failure', async () => {
    const target = await uploadOne();
    kit.shopify.failFileCreate = true;

    await expect(kit.media.service.storage.completeUpload(actor, target.mediaId)).rejects.toThrow('network down');
    expect((await MediaAssetModel.findById(target.mediaId).lean())?.status).toBe('awaiting_upload');

    kit.shopify.failFileCreate = false;
    const completed = await kit.media.service.storage.completeUpload(actor, target.mediaId);
    expect(completed.status).toBe('processing');
  });

  it('marks the asset failed when Shopify rejects the file', async () => {
    const target = await uploadOne();
    kit.shopify.fileCreateUserErrors = [{ field: ['files', '0'], message: 'The file type is not supported.', code: 'UNACCEPTABLE_ASSET' }];

    const completed = await kit.media.service.storage.completeUpload(actor, target.mediaId);

    expect(completed.status).toBe('failed');
    const record = await MediaAssetModel.findById(target.mediaId).lean();
    expect(record?.error).toEqual({ code: 'UNACCEPTABLE_ASSET', message: 'UNACCEPTABLE_ASSET: The file type is not supported.' });
    expect(record?.shopify?.fileGid).toBeUndefined();
  });

  it('answers not_found for unknown, malformed, foreign and output assets', async () => {
    const target = await uploadOne();
    const output = await MediaAssetModel.create({
      shopId: SHOP_ID,
      role: 'output',
      mediaType: 'image',
      status: 'awaiting_upload',
      filename: 'out.jpg',
      mimeType: 'image/jpeg',
      fileSize: 1,
    });

    for (const [who, id] of [
      [actor, newObjectId()],
      [actor, 'not-an-id'],
      [otherActor, target.mediaId],
      [actor, output._id.toHexString()],
    ] as const) {
      await expect(kit.media.service.storage.completeUpload(who, id)).rejects.toMatchObject({ code: 'not_found' });
    }
    expect(kit.shopify.count('FileCreate')).toBe(0);
  });
});

describe('lazy status refresh', () => {
  it('turns a processing image ready, throttled to one query per 3 seconds per asset', async () => {
    const { target, fileGid } = await uploadAndComplete();

    const first = await refresh([target.mediaId]);
    expect(first[0]?.status).toBe('processing');
    expect(kit.shopify.count('FileStatus')).toBe(1);

    // Within the window: no new query, even though the file is ready by now.
    kit.shopify.setReady(fileGid);
    kit.clock.advance(REFRESH_MIN_INTERVAL_MS - 1);
    expect((await refresh([target.mediaId]))[0]?.status).toBe('processing');
    expect(kit.shopify.count('FileStatus')).toBe(1);

    kit.clock.advance(1);
    const [ready] = await refresh([target.mediaId]);
    expect(kit.shopify.count('FileStatus')).toBe(2);
    expect(mediaObjectSchema.parse(ready)).toEqual(ready);
    expect(ready).toMatchObject({
      id: target.mediaId,
      status: 'ready',
      mediaType: 'image',
      url: expect.stringContaining('https://cdn.shopify.com/'),
      width: 1536,
      height: 2048,
      durationSec: null,
    });
    expect(ready?.previewUrl).toBe(ready?.url);

    // Ready assets are not queried again.
    kit.clock.advance(60_000);
    await refresh([target.mediaId]);
    expect(kit.shopify.count('FileStatus')).toBe(2);
    expect((await MediaAssetModel.findById(target.mediaId).lean())?.readyAt).toBeInstanceOf(Date);
  });

  it('stores the mp4 source, duration and poster for a video', async () => {
    const { target, fileGid } = await uploadAndComplete(videoFile('vid'));
    kit.shopify.setReady(fileGid);

    const [ready] = await refresh([target.mediaId]);

    expect(ready).toMatchObject({
      status: 'ready',
      mediaType: 'video',
      url: 'https://cdn.shopify.com/videos/c/vp/x/HD-1080p.mp4',
      previewUrl: expect.stringMatching(/\.jpg$/),
      width: 1080,
      height: 1920,
      durationSec: 8,
    });
  });

  it('falls back to the original source when no mp4 rendition exists', async () => {
    const { target, fileGid } = await uploadAndComplete(videoFile('vid'));
    kit.shopify.videoSources = [{ url: 'https://cdn.shopify.com/p.m3u8', format: 'm3u8', mimeType: 'application/x-mpegURL', width: 1080, height: 1920 }];
    kit.shopify.setReady(fileGid);

    expect((await refresh([target.mediaId]))[0]?.url).toBe('https://cdn.shopify.com/original.mov');
  });

  it('records a failed file with its error', async () => {
    const { target, fileGid } = await uploadAndComplete();
    kit.shopify.setFailed(fileGid, 'INVALID_IMAGE_RESOLUTION', "The image's resolution exceeds the max limit.");

    const [failed] = await refresh([target.mediaId]);

    expect(failed?.status).toBe('failed');
    expect((await MediaAssetModel.findById(target.mediaId).lean())?.error).toEqual({
      code: 'INVALID_IMAGE_RESOLUTION',
      message: "The image's resolution exceeds the max limit.",
    });
  });

  it('fails an asset whose file was deleted in Shopify', async () => {
    const { target, fileGid } = await uploadAndComplete();
    kit.shopify.remove(fileGid);

    expect((await refresh([target.mediaId]))[0]?.status).toBe('failed');
    expect((await MediaAssetModel.findById(target.mediaId).lean())?.error?.code).toBe('FILE_MISSING');
  });

  it('checks several assets with one query and skips the ones that are not processing', async () => {
    const a = await uploadAndComplete(imageFile('a'));
    const b = await uploadAndComplete(imageFile('b'));
    const waiting = await uploadOne(imageFile('c'));
    kit.shopify.setReady(a.fileGid);

    const items = await refresh([b.target.mediaId, waiting.mediaId, a.target.mediaId]);

    expect(items.map((item) => [item.id, item.status])).toEqual([
      [b.target.mediaId, 'processing'],
      [waiting.mediaId, 'awaiting_upload'],
      [a.target.mediaId, 'ready'],
    ]);
    expect(kit.shopify.count('FileStatus')).toBe(1);
    expect(kit.shopify.last('FileStatus').variables.ids).toEqual(expect.arrayContaining([a.fileGid, b.fileGid]));
    expect(kit.shopify.last('FileStatus').variables.ids).toHaveLength(2);
  });

  it('keeps the last known state when Shopify fails', async () => {
    const { target } = await uploadAndComplete();
    kit.shopify.failNextStatusQueries = 1;

    const [item] = await refresh([target.mediaId]);

    expect(item?.status).toBe('processing');
  });

  it('does not query Shopify for getObjects without refresh', async () => {
    const { target } = await uploadAndComplete();

    const items = await kit.media.service.getObjects(SHOP_ID, [target.mediaId]);

    expect(items[0]?.status).toBe('processing');
    expect(kit.shopify.count('FileStatus')).toBe(0);
  });
});

describe('tenant isolation', () => {
  it('hides the assets of another shop from every read', async () => {
    const { target } = await uploadAndComplete();
    const missing = newObjectId();

    expect(await kit.media.service.getAssets(OTHER_SHOP_ID, [target.mediaId])).toEqual([]);
    expect(await kit.media.service.getObjects(OTHER_SHOP_ID, [target.mediaId])).toEqual([]);
    expect(await refresh([target.mediaId, missing], OTHER_SHOP_ID)).toEqual([]);
    expect(kit.shopify.count('FileStatus')).toBe(0);
    expect(await kit.media.service.getAssets(SHOP_ID, [target.mediaId, missing, 'junk'])).toHaveLength(1);
  });

  it('returns assets in the requested order with their internal record', async () => {
    const a = await uploadOne(imageFile('a'));
    const b = await uploadOne(imageFile('b', { scope: 'product', productGid: 'gid://shopify/Product/3' }));

    const records = await kit.media.service.getAssets(SHOP_ID, [b.mediaId, a.mediaId, b.mediaId]);

    expect(records.map((record) => record.id)).toEqual([b.mediaId, a.mediaId]);
    expect(records[0]).toMatchObject({ shopId: SHOP_ID, role: 'reference', status: 'awaiting_upload', productGid: 'gid://shopify/Product/3', scope: 'product' });
  });
});

describe('deleteReference', () => {
  it('refuses with in_use while a batch uses the reference and does not touch Shopify', async () => {
    const used: string[] = [];
    kit = createKit({
      isMediaInUse: (shopId, mediaId) => {
        used.push(`${shopId}:${mediaId}`);
        return Promise.resolve(true);
      },
    });
    const { target } = await uploadAndComplete();

    await expect(kit.media.service.deleteReference(SHOP_ID, target.mediaId)).rejects.toMatchObject({ code: 'in_use', status: 409 });

    expect(used).toEqual([`${SHOP_ID}:${target.mediaId}`]);
    expect(kit.shopify.count('FileDelete')).toBe(0);
    expect((await MediaAssetModel.findById(target.mediaId).lean())?.status).toBe('processing');
  });

  it('deletes the Shopify file and marks the asset deleted', async () => {
    const { target, fileGid } = await uploadAndComplete();
    kit.shopify.setReady(fileGid);
    await refresh([target.mediaId]);

    await kit.media.service.deleteReference(SHOP_ID, target.mediaId);

    expect(kit.shopify.deleted).toEqual([fileGid]);
    expect(kit.shopify.last('FileDelete').variables).toEqual({ fileIds: [fileGid] });
    const record = await MediaAssetModel.findById(target.mediaId).lean();
    expect(record?.status).toBe('deleted');
    expect(record?.deletedAt).toBeInstanceOf(Date);

    // Deleting again is a no-op, and deleted assets stay visible as deleted.
    await kit.media.service.deleteReference(SHOP_ID, target.mediaId);
    expect(kit.shopify.count('FileDelete')).toBe(1);
    expect((await kit.media.service.getObjects(SHOP_ID, [target.mediaId]))[0]?.status).toBe('deleted');
  });

  it('skips fileDelete for an asset that never got a file', async () => {
    const target = await uploadOne();

    await kit.media.service.deleteReference(SHOP_ID, target.mediaId);

    expect(kit.shopify.count('FileDelete')).toBe(0);
    expect((await MediaAssetModel.findById(target.mediaId).lean())?.status).toBe('deleted');
  });

  it('treats a file that is already gone as deleted', async () => {
    const { target, fileGid } = await uploadAndComplete();
    kit.shopify.remove(fileGid);

    await kit.media.service.deleteReference(SHOP_ID, target.mediaId);

    expect((await MediaAssetModel.findById(target.mediaId).lean())?.status).toBe('deleted');
  });

  it('reports in_use when Shopify still has an operation on the file and keeps the asset', async () => {
    const { target } = await uploadAndComplete();
    kit.shopify.fileDeleteUserErrors = [{ field: ['fileIds'], message: 'File has a pending operation.', code: 'FILE_LOCKED' }];

    await expect(kit.media.service.deleteReference(SHOP_ID, target.mediaId)).rejects.toMatchObject({ code: 'in_use' });

    expect((await MediaAssetModel.findById(target.mediaId).lean())?.status).toBe('processing');
  });

  it('answers not_found for another shop and forbidden for outputs', async () => {
    const { target } = await uploadAndComplete();
    const output = await MediaAssetModel.create({
      shopId: SHOP_ID,
      role: 'output',
      mediaType: 'image',
      status: 'ready',
      filename: 'out.jpg',
      mimeType: 'image/jpeg',
      fileSize: 1,
    });

    await expect(kit.media.service.deleteReference(OTHER_SHOP_ID, target.mediaId)).rejects.toMatchObject({ code: 'not_found' });
    await expect(kit.media.service.deleteReference(SHOP_ID, newObjectId())).rejects.toMatchObject({ code: 'not_found' });
    await expect(kit.media.service.deleteReference(SHOP_ID, output._id.toHexString())).rejects.toMatchObject({ code: 'forbidden' });
    expect(kit.shopify.count('FileDelete')).toBe(0);
  });

  it('never deletes through the driver for a shop that does not own the asset', async () => {
    const { target } = await uploadAndComplete();

    await expect(kit.media.service.storage.delete(OTHER_SHOP_ID, target.mediaId)).rejects.toMatchObject({ code: 'not_found' });
    expect(kit.shopify.count('FileDelete')).toBe(0);
  });
});

describe('purgeShop', () => {
  it('removes only the records of that shop and leaves Shopify alone', async () => {
    const mine = await uploadAndComplete(imageFile('mine'));
    const [theirs] = await kit.media.service.storage.createUploadTargets(otherActor, [imageFile('theirs')]);

    await kit.media.service.purgeShop(SHOP_ID);

    expect(await MediaAssetModel.findById(mine.target.mediaId)).toBeNull();
    expect(await MediaAssetModel.findById(theirs?.mediaId)).not.toBeNull();
    expect(await MediaAssetModel.countDocuments()).toBe(1);
    expect(kit.shopify.count('FileDelete')).toBe(0);
  });
});
