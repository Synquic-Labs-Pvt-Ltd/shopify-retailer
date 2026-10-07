import type { MediaObject, UploadsRequest, UploadsResponse } from '@rs/shared';
import { ApiError } from '../types';
import { SAMPLE_VIDEO_URL, objectId, picture } from './util';

// Reference uploads in mock mode. The staged target is mock://staged-upload; the app replaces the multipart
// POST with fake progress. To exercise the failure paths: every 4th new file stops partway through the POST,
// and every 7th ends in a failed processing step. A retry (the same clientId again) always succeeds.
const UPLOAD_FAILS_EVERY = 4;
const PROCESSING_FAILS_EVERY = 7;
// GET /media polls a reference stays "processing" for.
const IMAGE_POLLS = 2;
const VIDEO_POLLS = 4;

interface StoredMedia {
  media: MediaObject;
  pollsLeft: number;
  failsProcessing: boolean;
}

export interface MockMediaStore {
  createUploads(body: UploadsRequest): UploadsResponse;
  complete(id: string): MediaObject;
  list(ids: string[]): MediaObject[];
  remove(id: string): void;
}

export function createMockMediaStore(): MockMediaStore {
  const stored = new Map<string, StoredMedia>();
  let counter = 0x500000;
  let uploads = 0;
  const seen = new Set<string>();

  const getEntry = (id: string): StoredMedia => {
    const entry = stored.get(id);
    if (entry === undefined) throw new ApiError(404, 'not_found', 'Media not found');
    return entry;
  };

  return {
    createUploads: (body) => ({
      targets: body.files.map((file) => {
        counter += 1;
        const isRetry = seen.has(file.clientId);
        seen.add(file.clientId);
        if (!isRetry) uploads += 1;
        const id = objectId(counter);
        const isVideo = file.mimeType.startsWith('video/');
        stored.set(id, {
          media: {
            id,
            role: 'reference',
            mediaType: isVideo ? 'video' : 'image',
            status: 'awaiting_upload',
            url: null,
            previewUrl: null,
            width: null,
            height: null,
            durationSec: file.durationSec ?? null,
            filename: file.filename,
            scope: file.scope,
            productGid: file.productGid ?? null,
            shotTitle: null,
            createdAt: new Date().toISOString(),
          },
          pollsLeft: isVideo ? VIDEO_POLLS : IMAGE_POLLS,
          failsProcessing: !isRetry && uploads % PROCESSING_FAILS_EVERY === 0,
        });
        const failsUpload = !isRetry && uploads % UPLOAD_FAILS_EVERY === 0;
        return {
          clientId: file.clientId,
          mediaId: id,
          url: failsUpload ? 'mock://staged-upload?fail=1' : 'mock://staged-upload',
          method: 'POST' as const,
          // Order matters on the real target: every parameter first, the file last.
          parameters: [
            { name: 'key', value: `tmp/mock/${id}/${file.filename}` },
            { name: 'Content-Type', value: file.mimeType },
          ],
        };
      }),
    }),

    complete: (id) => {
      const entry = getEntry(id);
      entry.media = { ...entry.media, status: 'processing' };
      return entry.media;
    },

    list: (ids) =>
      ids.flatMap((id) => {
        const entry = stored.get(id);
        if (entry === undefined) return [];
        if (entry.media.status === 'processing') {
          entry.pollsLeft -= 1;
          if (entry.pollsLeft <= 0) {
            const isVideo = entry.media.mediaType === 'video';
            entry.media = entry.failsProcessing
              ? { ...entry.media, status: 'failed' }
              : {
                  ...entry.media,
                  status: 'ready',
                  url: isVideo ? SAMPLE_VIDEO_URL : picture(`ref-${id}`, 1536, 2048),
                  previewUrl: picture(`ref-${id}`, 600, 800),
                  width: isVideo ? 720 : 1536,
                  height: isVideo ? 1280 : 2048,
                };
          }
        }
        return [entry.media];
      }),

    remove: (id) => {
      getEntry(id);
      stored.delete(id);
    },
  };
}
