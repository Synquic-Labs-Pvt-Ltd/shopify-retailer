import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { mediaObjectSchema } from '@rs/shared';
import { StorageUploadError, type PersistOutputInput } from '../../src/modules/media';
import { MediaAssetModel } from '../../src/modules/media/models';
import { IMAGE_READY_TIMEOUT_MS, POLL_INTERVAL_MS, VIDEO_READY_TIMEOUT_MS } from '../../src/modules/media/persist';
import { MONGO_START_TIMEOUT_MS, startTestMongo, type TestMongo } from '../helpers/mongo';
import { createKit, newObjectId, SHOP_ID, USER_ID, type MediaKit } from './kit';

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
  kit.shopify.defaultQueriesUntilReady = 2;
});

const BATCH_ID = newObjectId();
const ITEM_ID = newObjectId();
const PRODUCT = 'gid://shopify/Product/42';

function imageOutput(overrides: Partial<PersistOutputInput> = {}): PersistOutputInput {
  return {
    shopId: SHOP_ID,
    createdByUserId: USER_ID,
    batchId: BATCH_ID,
    batchItemId: ITEM_ID,
    sourceJobId: newObjectId(),
    productGid: PRODUCT,
    mediaType: 'image',
    mimeType: 'image/jpeg',
    bytes: new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4]),
    filename: 'rs-lamp-3f9a1c2b-img1.jpg',
    alt: 'Ceramic lamp: Hero on the sideboard',
    shotTitle: 'Hero on the sideboard',
    ...overrides,
  };
}

function videoOutput(overrides: Partial<PersistOutputInput> = {}): PersistOutputInput {
  return imageOutput({
    mediaType: 'video',
    mimeType: 'video/mp4',
    bytes: new Uint8Array(2048),
    filename: 'rs-lamp-3f9a1c2b-vid1.mp4',
    alt: 'Ceramic lamp: Slow push-in',
    shotTitle: 'Slow push-in',
    ...overrides,
  });
}

const persist = (input: PersistOutputInput) => kit.media.service.storage.persistOutput(input);

async function outputRecords() {
  return MediaAssetModel.find({ role: 'output' }).lean();
}

describe('persistOutput', () => {
  it('uploads an image through staged upload, multipart POST and fileCreate, then waits for READY', async () => {
    const input = imageOutput();
    const startedAt = kit.clock.now().getTime();

    const media = await persist(input);

    expect(mediaObjectSchema.parse(media)).toEqual(media);
    expect(media).toMatchObject({
      role: 'output',
      mediaType: 'image',
      status: 'ready',
      filename: input.filename,
      productGid: PRODUCT,
      shotTitle: 'Hero on the sideboard',
      scope: null,
      url: expect.stringContaining('https://cdn.shopify.com/'),
      width: 1536,
      height: 2048,
    });

    const staged = (kit.shopify.last('StagedUploadsCreate').variables.input as Record<string, string>[])[0];
    expect(staged).toEqual({ resource: 'IMAGE', filename: input.filename, mimeType: 'image/jpeg', fileSize: '8', httpMethod: 'POST' });

    expect(kit.fetchCalls).toHaveLength(1);
    const post = kit.fetchCalls[0];
    expect(post?.url).toMatch(/^https:\/\/staging\.example\/image\//);
    const entries = [...(post?.form.entries() ?? [])];
    expect(entries.map(([name]) => name)).toEqual(['key', 'policy', 'file']);
    expect(entries[0]?.[1]).toContain(input.filename);
    const file = entries[2]?.[1];
    expect(file).toBeInstanceOf(Blob);
    expect((file as File).name).toBe(input.filename);
    expect((file as File).type).toBe('image/jpeg');
    expect(new Uint8Array(await (file as File).arrayBuffer())).toEqual(input.bytes);

    const files = kit.shopify.last('FileCreate').variables.files as Record<string, string>[];
    expect(files).toEqual([
      { originalSource: expect.stringContaining(`/${input.filename}`), contentType: 'IMAGE', filename: input.filename, alt: input.alt },
    ]);
    expect(files[0]?.originalSource).toMatch(/^https:\/\/staging\.example\/files\//);

    // Two status queries, three seconds apart.
    expect(kit.shopify.count('FileStatus')).toBe(2);
    expect(kit.clock.now().getTime() - startedAt).toBe(2 * POLL_INTERVAL_MS);

    const [record] = await outputRecords();
    expect(record).toMatchObject({
      role: 'output',
      status: 'ready',
      fileSize: 8,
      alt: input.alt,
      mimeType: 'image/jpeg',
      productGid: PRODUCT,
    });
    expect(record?.shopId.toHexString()).toBe(SHOP_ID);
    expect(record?.createdByUserId?.toHexString()).toBe(USER_ID);
    expect(record?.batchId?.toHexString()).toBe(BATCH_ID);
    expect(record?.batchItemId?.toHexString()).toBe(ITEM_ID);
    expect(record?.sourceJobId?.toHexString()).toBe(input.sourceJobId);
    expect(record?.shopify?.fileGid).toMatch(/^gid:\/\/shopify\/MediaImage\//);
  });

  it('uploads a video with the VIDEO resource and stores the mp4 source', async () => {
    const media = await persist(videoOutput());

    expect(media).toMatchObject({
      role: 'output',
      mediaType: 'video',
      status: 'ready',
      url: 'https://cdn.shopify.com/videos/c/vp/x/HD-1080p.mp4',
      previewUrl: expect.stringMatching(/\.jpg$/),
      durationSec: 8,
    });
    const staged = (kit.shopify.last('StagedUploadsCreate').variables.input as Record<string, string>[])[0];
    expect(staged).toMatchObject({ resource: 'VIDEO', mimeType: 'video/mp4', fileSize: '2048' });
    expect((kit.shopify.last('FileCreate').variables.files as Record<string, string>[])[0]?.contentType).toBe('VIDEO');
  });

  it('is idempotent per sourceJobId: the second call returns the first result with no new upload', async () => {
    const input = imageOutput();

    const first = await persist(input);
    const second = await persist(input);

    expect(second).toEqual(first);
    expect(kit.shopify.count('StagedUploadsCreate')).toBe(1);
    expect(kit.shopify.count('FileCreate')).toBe(1);
    expect(kit.fetchCalls).toHaveLength(1);
    expect(await outputRecords()).toHaveLength(1);
  });

  it('shares one upload between concurrent calls for the same job', async () => {
    const input = imageOutput();

    const [a, b] = await Promise.all([persist(input), persist(input)]);

    expect(a).toEqual(b);
    expect(kit.shopify.count('StagedUploadsCreate')).toBe(1);
    expect(kit.fetchCalls).toHaveLength(1);
    expect(await outputRecords()).toHaveLength(1);
  });

  it('finishes a record that an earlier attempt created but never uploaded', async () => {
    const input = imageOutput();
    await MediaAssetModel.create({
      shopId: SHOP_ID,
      sourceJobId: input.sourceJobId,
      role: 'output',
      mediaType: 'image',
      status: 'awaiting_upload',
      filename: input.filename,
      mimeType: input.mimeType,
      fileSize: input.bytes.byteLength,
    });

    const media = await persist(input);

    expect(media.status).toBe('ready');
    expect(await outputRecords()).toHaveLength(1);
    expect(kit.shopify.count('StagedUploadsCreate')).toBe(1);
  });

  it('uploads different jobs separately', async () => {
    await persist(imageOutput({ filename: 'rs-lamp-3f9a1c2b-img1.jpg' }));
    await persist(imageOutput({ filename: 'rs-lamp-3f9a1c2b-img2.jpg' }));

    expect(kit.shopify.count('StagedUploadsCreate')).toBe(2);
    expect(await outputRecords()).toHaveLength(2);
  });

  it('truncates an alt text longer than 512 characters', async () => {
    await persist(imageOutput({ alt: 'x'.repeat(600) }));

    expect((kit.shopify.last('FileCreate').variables.files as Record<string, string>[])[0]?.alt).toHaveLength(512);
  });
});

describe('persistOutput waiting', () => {
  it('times out after 2 minutes for an image and keeps the record so a retry resumes', async () => {
    kit.shopify.defaultQueriesUntilReady = null;
    const input = imageOutput();
    const startedAt = kit.clock.now().getTime();

    const error = await persist(input).catch((err: unknown) => err);

    expect(error).toBeInstanceOf(StorageUploadError);
    expect(error).toMatchObject({ code: 'shopify_upload_failed', retryable: true, message: expect.stringContaining('Timed out after 120 s') });
    expect(kit.clock.now().getTime() - startedAt).toBeGreaterThanOrEqual(IMAGE_READY_TIMEOUT_MS);
    expect(kit.clock.now().getTime() - startedAt).toBeLessThan(IMAGE_READY_TIMEOUT_MS + 2 * POLL_INTERVAL_MS);
    expect(kit.shopify.count('FileStatus')).toBe(IMAGE_READY_TIMEOUT_MS / POLL_INTERVAL_MS);

    const [record] = await outputRecords();
    expect(record?.status).toBe('processing');

    // The file finishes later; the retried job picks it up without uploading again.
    const [fileGid] = kit.shopify.gids();
    kit.shopify.setReady(fileGid ?? '');
    const media = await persist(input);

    expect(media.status).toBe('ready');
    expect(kit.shopify.count('StagedUploadsCreate')).toBe(1);
    expect(kit.shopify.count('FileCreate')).toBe(1);
    expect(kit.fetchCalls).toHaveLength(1);
  });

  it('allows a video 10 minutes', async () => {
    kit.shopify.defaultQueriesUntilReady = null;
    const startedAt = kit.clock.now().getTime();

    const error = await persist(videoOutput()).catch((err: unknown) => err);

    expect(error).toMatchObject({ code: 'shopify_upload_failed', retryable: true, message: expect.stringContaining('Timed out after 600 s') });
    expect(kit.clock.now().getTime() - startedAt).toBeGreaterThanOrEqual(VIDEO_READY_TIMEOUT_MS);
    expect(kit.shopify.count('FileStatus')).toBe(VIDEO_READY_TIMEOUT_MS / POLL_INTERVAL_MS);
  });

  it('records a file that Shopify failed to process and uploads again on the next attempt', async () => {
    const input = imageOutput();
    kit.shopify.resolveAs = 'FAILED';

    const error = await persist(input).catch((err: unknown) => err);

    expect(error).toBeInstanceOf(StorageUploadError);
    expect(error).toMatchObject({ retryable: true, message: expect.stringContaining('The image could not be processed.') });
    const [failed] = await outputRecords();
    expect(failed?.status).toBe('failed');
    expect(failed?.error?.code).toBe('IMAGE_PROCESSING_FAILURE');

    kit.shopify.resolveAs = 'READY';
    const media = await persist(input);
    expect(media.status).toBe('ready');
    expect(kit.shopify.count('StagedUploadsCreate')).toBe(2);
    expect(await outputRecords()).toHaveLength(1);
  });

  it('survives a failed status query but gives up after three in a row', async () => {
    kit.shopify.failNextStatusQueries = 1;
    expect((await persist(imageOutput())).status).toBe('ready');

    kit.shopify.failNextStatusQueries = 3;
    const error = await persist(imageOutput()).catch((err: unknown) => err);
    expect(error).toBeInstanceOf(StorageUploadError);
    expect(error).toMatchObject({ retryable: true, message: expect.stringContaining('Shopify is unavailable') });
  });
});

describe('persistOutput failures', () => {
  it('does not call fileCreate when the staged POST is rejected, and works on the next attempt', async () => {
    let status = 403;
    kit = createKit({ fetchImpl: () => Promise.resolve(new Response('<Error>AccessDenied</Error>', { status })) });
    kit.shopify.defaultQueriesUntilReady = 1;
    const input = imageOutput();

    const rejected = await persist(input).catch((err: unknown) => err);
    expect(rejected).toBeInstanceOf(StorageUploadError);
    expect(rejected).toMatchObject({ retryable: false, message: expect.stringContaining('HTTP 403') });
    expect(rejected).toMatchObject({ message: expect.stringContaining('AccessDenied') });
    expect(kit.shopify.count('FileCreate')).toBe(0);
    expect((await outputRecords())[0]?.status).toBe('awaiting_upload');

    status = 503;
    await expect(persist(input)).rejects.toMatchObject({ retryable: true });

    status = 201;
    expect((await persist(input)).status).toBe('ready');
    expect(await outputRecords()).toHaveLength(1);
  });

  it('reports a transport failure of the POST as retryable', async () => {
    kit = createKit({ fetchImpl: () => Promise.reject(new Error('socket hang up')) });

    const error = await persist(imageOutput()).catch((err: unknown) => err);

    expect(error).toBeInstanceOf(StorageUploadError);
    expect(error).toMatchObject({ retryable: true, message: expect.stringContaining('socket hang up') });
  });

  it('marks the record failed and does not retry when Shopify rejects the file', async () => {
    kit.shopify.fileCreateUserErrors = [{ field: ['files', '0'], message: 'The file type is not supported.', code: 'UNACCEPTABLE_ASSET' }];

    const error = await persist(imageOutput()).catch((err: unknown) => err);

    expect(error).toBeInstanceOf(StorageUploadError);
    expect(error).toMatchObject({ retryable: false });
    const [record] = await outputRecords();
    expect(record).toMatchObject({ status: 'failed', error: { code: 'UNACCEPTABLE_ASSET' } });
  });

  it('wraps a Shopify error from stagedUploadsCreate', async () => {
    kit.shopify.stagedUserErrors = [{ field: null, message: 'Bad input' }];

    const error = await persist(imageOutput()).catch((err: unknown) => err);

    expect(error).toBeInstanceOf(StorageUploadError);
    expect(error).toMatchObject({ code: 'shopify_upload_failed', retryable: true });
    expect(kit.fetchCalls).toHaveLength(0);
  });
});
