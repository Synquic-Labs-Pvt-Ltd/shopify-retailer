import { ApiError } from '@rs/shared';
import { describe, expect, it } from 'vitest';
import { createDraftStore } from '@/lib/state/draft';
import { allDraftRefs } from '@/lib/state/draftData';
import { createMemoryStorage } from '@/lib/state/draftStorage';
import type { DraftReference, ReferenceTarget } from '@/lib/state/draftTypes';
import { createFileRegistry } from '@/lib/state/fileRegistry';
import {
  createControlledTransport,
  createFakeMediaApi,
  flush,
  makeFile,
  mediaObject,
  slot,
} from './testkit';
import type { UploadTransport } from './transport';
import { UploadBlockedError, UploadError } from './uploadErrors';
import {
  applyMediaStatus,
  createUploadService,
  FILE_GONE_MESSAGE,
  PROCESSING_FAILED_MESSAGE,
  uploadErrorMessage,
} from './uploadService';

const GID = 'gid://shopify/Product/1';

function setup(transportOverride?: UploadTransport) {
  const files = createFileRegistry();
  const store = createDraftStore({ storage: createMemoryStorage(), files });
  const media = createFakeMediaApi();
  const controlled = createControlledTransport();
  const service = createUploadService({
    draft: store,
    files,
    api: media.api,
    transport: transportOverride ?? controlled.transport,
  });
  const add = (id: string, target: ReferenceTarget = { kind: 'common' }, patch: Partial<DraftReference> = {}) => {
    store.getState().addRef(target, slot(id, patch));
    files.set(id, makeFile(`${id}.jpg`, 'image/jpeg', 2048));
  };
  const find = (id: string) => allDraftRefs(store.getState()).find((ref) => ref.clientId === id);
  return { files, store, media, controlled, service, add, find };
}

const instant: UploadTransport = { upload: () => Promise.resolve() };

describe('enqueue', () => {
  it('stages every slot in one request with scope, product, size and duration', async () => {
    const { add, service, media } = setup(instant);
    add('a');
    add('b', { kind: 'product', productId: GID }, { mediaType: 'video', mimeType: 'video/mp4', durationSec: 12.5 });
    await service.enqueue(['a', 'b']);
    expect(media.createCalls).toHaveLength(1);
    expect(media.createCalls[0]?.files).toEqual([
      { clientId: 'a', filename: 'a.jpg', mimeType: 'image/jpeg', fileSize: 2048, scope: 'common' },
      {
        clientId: 'b',
        filename: 'b.jpg',
        mimeType: 'video/mp4',
        fileSize: 2048,
        durationSec: 12.5,
        scope: 'product',
        productGid: GID,
      },
    ]);
  });

  it('splits more than 50 files into several staging requests', async () => {
    const { add, service, media } = setup(instant);
    const ids = Array.from({ length: 120 }, (_, index) => `s${index}`);
    for (const id of ids) add(id);
    const summary = await service.enqueue(ids);
    expect(media.createCalls.map((call) => call.files.length)).toEqual([50, 50, 20]);
    expect(summary).toEqual({ failed: 0, blocked: false });
  });

  it('runs two uploads at a time, first come first served', async () => {
    const { add, service, controlled, find } = setup();
    const ids = ['a', 'b', 'c', 'd', 'e'];
    for (const id of ids) add(id);
    const done = service.enqueue(ids);

    await flush();
    expect(controlled.started.map((upload) => upload.file.name)).toEqual(['a.jpg', 'b.jpg']);
    expect(controlled.inFlight).toBe(2);
    expect(find('c')?.status).toBe('uploading');

    controlled.started[0]?.resolve();
    await flush();
    expect(controlled.started).toHaveLength(3);
    expect(controlled.inFlight).toBe(2);

    for (let index = 1; index < 5; index += 1) {
      controlled.started[index]?.resolve();
      await flush();
    }
    expect(await done).toEqual({ failed: 0, blocked: false });
    expect(controlled.started).toHaveLength(5);
    expect(controlled.maxInFlight).toBe(2);
    expect(ids.map((id) => find(id)?.status)).toEqual(ids.map(() => 'processing'));
  });

  it('shares the limit between separate calls', async () => {
    const { add, service, controlled } = setup();
    for (const id of ['a', 'b', 'c']) add(id);
    const first = service.enqueue(['a', 'b']);
    const second = service.enqueue(['c']);
    await flush();
    expect(controlled.started).toHaveLength(2);
    controlled.started[0]?.resolve();
    controlled.started[1]?.resolve();
    await flush();
    controlled.started[2]?.resolve();
    await Promise.all([first, second]);
    expect(controlled.maxInFlight).toBe(2);
  });

  it('writes progress to the draft in 4% steps and finishes as processing', async () => {
    const { add, service, controlled, find, media } = setup();
    add('a');
    const done = service.enqueue(['a']);
    await flush();
    const upload = controlled.started[0];
    expect(find('a')).toMatchObject({ status: 'uploading', mediaId: 'media-1', progress: 0 });

    const seen: number[] = [];
    for (const fraction of [0.01, 0.03, 0.05, 0.06, 0.08, 0.09, 0.5, 0.52, 0.99, 1, 1]) {
      upload?.onProgress(fraction);
      const progress = find('a')?.progress ?? -1;
      if (seen[seen.length - 1] !== progress) seen.push(progress);
    }
    expect(seen).toEqual([0, 0.05, 0.09, 0.5, 0.99, 1]);

    upload?.resolve();
    await done;
    expect(media.completed).toEqual(['media-1']);
    expect(find('a')).toMatchObject({ status: 'processing', progress: 1, mediaId: 'media-1', error: null });
  });

  it('marks a slot ready when completing it returns a ready media object', async () => {
    const { add, service, media, find, files } = setup(instant);
    media.hooks.complete = async (id) => mediaObject(id, 'ready', { previewUrl: 'https://cdn.example/p.jpg' });
    add('a');
    await service.enqueue(['a']);
    expect(find('a')).toMatchObject({ status: 'ready', previewUrl: 'https://cdn.example/p.jpg' });
    expect(files.has('a')).toBe(false);
  });

  it('fails only the slot whose transfer failed and counts it', async () => {
    const { add, service, controlled, find } = setup();
    add('a');
    add('b');
    const done = service.enqueue(['a', 'b']);
    await flush();
    controlled.started[0]?.reject(new UploadError('The upload was rejected (HTTP 403).'));
    controlled.started[1]?.resolve();
    expect(await done).toEqual({ failed: 1, blocked: false });
    expect(find('a')).toMatchObject({ status: 'failed', progress: 0, error: 'The upload was rejected (HTTP 403).' });
    expect(find('b')?.status).toBe('processing');
  });

  it('reports a blocked browser upload distinctly', async () => {
    const { add, service, controlled, find } = setup();
    add('a');
    const done = service.enqueue(['a']);
    await flush();
    controlled.started[0]?.reject(new UploadBlockedError());
    const summary = await done;
    expect(summary).toEqual({ failed: 1, blocked: true });
    expect(find('a')?.error).toBe(new UploadBlockedError().message);
  });

  it('fails every slot of a request that could not be staged', async () => {
    const { add, service, media, find } = setup(instant);
    media.hooks.createUploads = async () => {
      throw new ApiError(0, 'network_error', 'Cannot reach the server');
    };
    add('a');
    add('b');
    expect(await service.enqueue(['a', 'b'])).toEqual({ failed: 2, blocked: false });
    expect(find('a')?.error).toBe('Cannot reach the server. Check your connection and try again.');
    expect(find('b')?.status).toBe('failed');
  });

  it('fails a slot the server returned no target for', async () => {
    const { add, service, media, find } = setup(instant);
    media.hooks.createUploads = async () => ({ targets: [] });
    add('a');
    expect(await service.enqueue(['a'])).toEqual({ failed: 1, blocked: false });
    expect(find('a')?.error).toBe('The server did not return an upload target.');
  });

  it('fails a slot whose File is gone', async () => {
    const { add, service, files, find, media } = setup(instant);
    add('a');
    files.delete('a');
    expect(await service.enqueue(['a'])).toEqual({ failed: 1, blocked: false });
    expect(find('a')?.error).toBe(FILE_GONE_MESSAGE);
    expect(media.createCalls).toHaveLength(0);
  });

  it('fails the slot when completing the upload is refused', async () => {
    const { add, service, media, find } = setup(instant);
    media.hooks.complete = async () => {
      throw new ApiError(404, 'not_found', 'Media not found');
    };
    add('a');
    expect(await service.enqueue(['a'])).toEqual({ failed: 1, blocked: false });
    expect(find('a')).toMatchObject({ status: 'failed', error: 'Media not found' });
  });

  it('counts a media object that comes back failed as a failure', async () => {
    const { add, service, media, find } = setup(instant);
    media.hooks.complete = async (id) => mediaObject(id, 'failed');
    add('a');
    expect(await service.enqueue(['a'])).toEqual({ failed: 1, blocked: false });
    expect(find('a')?.error).toBe(PROCESSING_FAILED_MESSAGE);
  });

  it('ignores slots that are already in flight', async () => {
    const { add, service, controlled, media } = setup();
    add('a');
    const first = service.enqueue(['a']);
    await flush();
    expect(service.isBusy('a')).toBe(true);
    await service.enqueue(['a']);
    expect(media.createCalls).toHaveLength(1);
    controlled.started[0]?.resolve();
    await first;
    expect(service.isBusy('a')).toBe(false);
  });
});

describe('retry', () => {
  it('deletes the old record quietly and uploads the File again', async () => {
    const { add, service, controlled, find, media } = setup();
    add('a');
    const first = service.enqueue(['a']);
    await flush();
    controlled.started[0]?.reject(new UploadError('The upload timed out.'));
    await first;
    expect(find('a')).toMatchObject({ status: 'failed', mediaId: 'media-1' });

    const second = service.retry('a');
    await flush();
    expect(media.removed).toEqual(['media-1']);
    expect(find('a')).toMatchObject({ status: 'uploading', mediaId: 'media-2', error: null });
    controlled.started[1]?.resolve();
    expect(await second).toEqual({ failed: 0, blocked: false });
    expect(find('a')).toMatchObject({ status: 'processing', mediaId: 'media-2' });
  });

  it('does nothing for a slot that has not failed', async () => {
    const { add, service, media } = setup(instant);
    add('a');
    expect(await service.retry('a')).toEqual({ failed: 0, blocked: false });
    expect(await service.retry('missing')).toEqual({ failed: 0, blocked: false });
    expect(media.createCalls).toHaveLength(0);
  });

  it('keeps a failed slot failed when its File is gone', async () => {
    const { add, service, find, files, media } = setup(instant);
    add('a', { kind: 'common' }, { status: 'failed', error: 'The upload was interrupted.' });
    files.delete('a');
    expect(await service.retry('a')).toEqual({ failed: 1, blocked: false });
    expect(find('a')).toMatchObject({ status: 'failed', error: FILE_GONE_MESSAGE });
    expect(media.createCalls).toHaveLength(0);
  });
});

describe('remove', () => {
  it('aborts a running upload, drops the slot and deletes the record', async () => {
    const { add, service, controlled, find, files, media } = setup();
    add('a');
    const done = service.enqueue(['a']);
    await flush();
    service.remove('a');
    expect(controlled.started[0]?.signal.aborted).toBe(true);
    expect(find('a')).toBeUndefined();
    expect(files.has('a')).toBe(false);
    expect(await done).toEqual({ failed: 0, blocked: false });
    expect(media.removed).toEqual(['media-1']);
    expect(media.completed).toEqual([]);
  });

  it('deletes the record of a slot removed while it waited in the queue', async () => {
    const { add, service, controlled, media } = setup();
    for (const id of ['a', 'b', 'c']) add(id);
    const done = service.enqueue(['a', 'b', 'c']);
    await flush();
    service.remove('c');
    controlled.started[0]?.resolve();
    controlled.started[1]?.resolve();
    expect(await done).toEqual({ failed: 0, blocked: false });
    expect(controlled.started).toHaveLength(2);
    expect(media.removed).toContain('media-3');
  });

  it('deletes the orphan when the slot is removed before the target arrives', async () => {
    const { add, service, media, controlled } = setup();
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    media.hooks.createUploads = async (body) => {
      await gate;
      return {
        targets: body.files.map((file) => ({
          clientId: file.clientId,
          mediaId: 'late-media',
          url: 'https://staged.example/upload',
          method: 'POST' as const,
          parameters: [],
        })),
      };
    };
    add('a');
    const done = service.enqueue(['a']);
    await flush();
    service.remove('a');
    release();
    expect(await done).toEqual({ failed: 0, blocked: false });
    expect(controlled.started).toHaveLength(0);
    expect(media.removed).toEqual(['late-media']);
  });

  it('deletes the record when the slot is removed while completing', async () => {
    const { add, service, media, controlled, find } = setup();
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    media.hooks.complete = async (id) => {
      await gate;
      return mediaObject(id, 'processing');
    };
    add('a');
    const done = service.enqueue(['a']);
    await flush();
    controlled.started[0]?.resolve();
    await flush();
    service.remove('a');
    release();
    expect(await done).toEqual({ failed: 0, blocked: false });
    expect(find('a')).toBeUndefined();
    expect(media.removed).toEqual(['media-1', 'media-1']);
  });

  it('ignores an in_use answer from DELETE', async () => {
    const { add, service, media, store } = setup(instant);
    media.hooks.complete = async (id) => mediaObject(id, 'ready');
    media.hooks.remove = async () => {
      throw new ApiError(409, 'in_use', 'This media is used by a running batch');
    };
    add('a');
    await service.enqueue(['a']);
    store.getState().updateRef('a', { mediaId: 'media-1' });
    service.remove('a');
    await flush();
    expect(media.removed).toEqual(['media-1']);
    expect(store.getState().commonRefs).toEqual([]);
  });
});

describe('applyMediaStatus', () => {
  const base = slot('a', { mediaId: 'm1', previewUrl: 'data:image/jpeg;base64,AAA', progress: 0.4 });

  it('maps ready with the server preview, keeping the local one when there is none', () => {
    expect(applyMediaStatus(base, mediaObject('m1', 'ready', { previewUrl: 'https://cdn/p.jpg' }))).toMatchObject({
      status: 'ready',
      progress: 1,
      previewUrl: 'https://cdn/p.jpg',
      error: null,
    });
    expect(applyMediaStatus(base, mediaObject('m1', 'ready')).previewUrl).toBe('data:image/jpeg;base64,AAA');
  });

  it('maps failed and deleted to a failed slot with a message', () => {
    for (const status of ['failed', 'deleted'] as const) {
      expect(applyMediaStatus(base, mediaObject('m1', status))).toMatchObject({
        status: 'failed',
        progress: 0,
        error: PROCESSING_FAILED_MESSAGE,
      });
    }
  });

  it('maps awaiting_upload and processing to processing', () => {
    for (const status of ['awaiting_upload', 'processing'] as const) {
      expect(applyMediaStatus(base, mediaObject('m1', status))).toMatchObject({ status: 'processing', progress: 1 });
    }
  });
});

describe('uploadErrorMessage', () => {
  it('uses the message of transfer errors and the api wording for api errors', () => {
    expect(uploadErrorMessage(new UploadError('The upload timed out.'))).toBe('The upload timed out.');
    expect(uploadErrorMessage(new ApiError(404, 'not_found', 'Media not found'))).toBe('Media not found');
    expect(uploadErrorMessage(new ApiError(500, 'internal', 'boom'))).toBe('The upload failed.');
    expect(uploadErrorMessage(new Error('x'))).toBe('The upload failed.');
  });
});
