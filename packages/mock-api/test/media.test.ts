import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  mediaCompleteResponseSchema,
  mediaListResponseSchema,
  uploadsResponseSchema,
  type Api,
  type MediaObject,
  type UploadsRequest,
} from '@rs/shared';
import { productGid } from '../src/util';
import { cleanup, expectApiError, freshApi } from './helpers';

let api: Api;
beforeEach(() => {
  api = freshApi();
});
afterEach(cleanup);

const imageFile = (clientId: string): UploadsRequest['files'][number] => ({
  clientId,
  filename: `${clientId}.jpg`,
  mimeType: 'image/jpeg',
  fileSize: 1_000_000,
  scope: 'common',
});

async function upload(clientId: string, file: Partial<UploadsRequest['files'][number]> = {}) {
  const response = uploadsResponseSchema.parse(await api.media.createUploads({ files: [{ ...imageFile(clientId), ...file }] }));
  const target = response.targets[0];
  if (target === undefined) throw new Error('no target');
  return target;
}

async function listOne(id: string): Promise<MediaObject> {
  const response = mediaListResponseSchema.parse(await api.media.list([id]));
  const media = response.items[0];
  if (media === undefined) throw new Error('media missing');
  return media;
}

describe('upload targets', () => {
  it('returns one staged target per file, parameters first, and registers the media', async () => {
    const response = uploadsResponseSchema.parse(
      await api.media.createUploads({
        files: [
          imageFile('a'),
          { clientId: 'b', filename: 'clip.mp4', mimeType: 'video/mp4', fileSize: 5_000_000, durationSec: 12, scope: 'product', productGid: productGid(3) },
        ],
      }),
    );
    expect(response.targets.map((target) => target.clientId)).toEqual(['a', 'b']);
    for (const target of response.targets) {
      expect(target.method).toBe('POST');
      expect(target.url).toBe('mock://staged-upload');
      expect(target.parameters.map((parameter) => parameter.name)).toEqual(['key', 'Content-Type']);
    }

    const [image, video] = mediaListResponseSchema.parse(
      await api.media.list(response.targets.map((target) => target.mediaId)),
    ).items;
    expect(image).toMatchObject({ role: 'reference', mediaType: 'image', status: 'awaiting_upload', scope: 'common', url: null });
    expect(video).toMatchObject({ mediaType: 'video', durationSec: 12, scope: 'product', productGid: productGid(3) });
  });

  it('makes every 4th new file stop partway and a retry of the same clientId succeed', async () => {
    const urls: string[] = [];
    for (const clientId of ['c1', 'c2', 'c3', 'c4']) urls.push((await upload(clientId)).url);
    expect(urls).toEqual([
      'mock://staged-upload',
      'mock://staged-upload',
      'mock://staged-upload',
      'mock://staged-upload?fail=1',
    ]);
    expect((await upload('c4')).url).toBe('mock://staged-upload');
  });
});

describe('media status', () => {
  it('moves awaiting_upload -> processing -> ready after two polls for an image', async () => {
    const { mediaId } = await upload('img');
    expect((await listOne(mediaId)).status).toBe('awaiting_upload');

    const completed = mediaCompleteResponseSchema.parse(await api.media.complete(mediaId));
    expect(completed.status).toBe('processing');
    expect((await listOne(mediaId)).status).toBe('processing');

    const ready = await listOne(mediaId);
    expect(ready).toMatchObject({ status: 'ready', width: 1536, height: 2048 });
    expect(ready.url).toContain('picsum.photos');
    expect(ready.previewUrl).not.toBeNull();
  });

  it('keeps a video processing for four polls', async () => {
    const { mediaId } = await upload('vid', { filename: 'clip.mp4', mimeType: 'video/mp4', durationSec: 8 });
    await api.media.complete(mediaId);
    const statuses: string[] = [];
    for (let poll = 0; poll < 4; poll += 1) statuses.push((await listOne(mediaId)).status);
    expect(statuses).toEqual(['processing', 'processing', 'processing', 'ready']);
  });

  it('fails the processing step of every 7th new file, not of its retry', async () => {
    for (const clientId of ['p1', 'p2', 'p3', 'p4', 'p5', 'p6']) await upload(clientId);
    const seventh = await upload('p7');
    await api.media.complete(seventh.mediaId);
    await listOne(seventh.mediaId);
    expect((await listOne(seventh.mediaId)).status).toBe('failed');

    const retry = await upload('p7');
    await api.media.complete(retry.mediaId);
    await listOne(retry.mediaId);
    expect((await listOne(retry.mediaId)).status).toBe('ready');
  });

  it('skips ids it does not know and lists known ones in request order', async () => {
    const first = await upload('k1');
    const second = await upload('k2');
    const items = mediaListResponseSchema.parse(await api.media.list([second.mediaId, 'f'.repeat(24), first.mediaId])).items;
    expect(items.map((item) => item.id)).toEqual([second.mediaId, first.mediaId]);
  });
});

describe('media errors and removal', () => {
  it('404s when completing or removing an unknown id', async () => {
    await expectApiError(api.media.complete('a'.repeat(24)), 'not_found');
    await expectApiError(api.media.remove('a'.repeat(24)), 'not_found');
  });

  it('removes a reference so it no longer lists', async () => {
    const { mediaId } = await upload('gone');
    await api.media.remove(mediaId);
    expect(mediaListResponseSchema.parse(await api.media.list([mediaId])).items).toEqual([]);
    await expectApiError(api.media.complete(mediaId), 'not_found');
  });
});
