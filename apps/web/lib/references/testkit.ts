import type { MediaObject, UploadTarget, UploadsRequest } from '@rs/shared';
import type { DraftReference } from '@/lib/state/draftTypes';
import type { ReferenceLimits } from './limits';
import type { ProgressListener, UploadTransport } from './transport';
import { UploadAbortedError } from './uploadErrors';
import type { UploadServiceDeps } from './uploadService';

// Fakes shared by the unit tests of this folder. Not imported by app code.

export const LIMITS: ReferenceLimits = {
  maxPerProduct: 5,
  maxCommon: 10,
  maxImageMB: 20,
  maxVideoMB: 100,
  maxVideoSeconds: 60,
  imageMimeTypes: ['image/jpeg', 'image/png', 'image/webp'],
  videoMimeTypes: ['video/mp4', 'video/quicktime'],
};

export const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

export function makeFile(name: string, type: string, size = 1000): File {
  return new File([new Uint8Array(size)], name, { type });
}

export function slot(clientId: string, patch: Partial<DraftReference> = {}): DraftReference {
  return {
    clientId,
    mediaId: null,
    mediaType: 'image',
    filename: `${clientId}.jpg`,
    mimeType: 'image/jpeg',
    fileSize: 1000,
    durationSec: null,
    status: 'uploading',
    progress: 0,
    previewUrl: null,
    error: null,
    ...patch,
  };
}

export function mediaObject(id: string, status: MediaObject['status'], patch: Partial<MediaObject> = {}): MediaObject {
  return {
    id,
    role: 'reference',
    mediaType: 'image',
    status,
    url: null,
    previewUrl: null,
    width: null,
    height: null,
    durationSec: null,
    filename: 'x.jpg',
    scope: 'common',
    productGid: null,
    shotTitle: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    ...patch,
  };
}

export interface FakeMediaApi {
  api: UploadServiceDeps['api'];
  createCalls: UploadsRequest[];
  completed: string[];
  removed: string[];
  // Overrides, set by a test before the call it wants to affect.
  hooks: {
    createUploads?: (body: UploadsRequest) => Promise<{ targets: UploadTarget[] }>;
    complete?: (id: string) => Promise<MediaObject>;
    remove?: (id: string) => Promise<void>;
  };
}

export function createFakeMediaApi(): FakeMediaApi {
  let counter = 0;
  const fake: FakeMediaApi = { api: undefined as never, createCalls: [], completed: [], removed: [], hooks: {} };
  fake.api = {
    createUploads: async (body) => {
      fake.createCalls.push(body);
      if (fake.hooks.createUploads !== undefined) return fake.hooks.createUploads(body);
      return {
        targets: body.files.map((file) => {
          counter += 1;
          return {
            clientId: file.clientId,
            mediaId: `media-${counter}`,
            url: 'https://staged.example/upload',
            method: 'POST' as const,
            parameters: [{ name: 'key', value: `tmp/${counter}` }],
          };
        }),
      };
    },
    complete: async (id) => {
      fake.completed.push(id);
      return fake.hooks.complete !== undefined ? fake.hooks.complete(id) : mediaObject(id, 'processing');
    },
    remove: async (id) => {
      fake.removed.push(id);
      if (fake.hooks.remove !== undefined) await fake.hooks.remove(id);
    },
  };
  return fake;
}

export interface PendingUpload {
  target: UploadTarget;
  file: File;
  onProgress: ProgressListener;
  signal: AbortSignal;
  resolve(): void;
  reject(error: Error): void;
}

export interface ControlledTransport {
  transport: UploadTransport;
  started: PendingUpload[];
  readonly inFlight: number;
  readonly maxInFlight: number;
}

// Every upload stays open until the test settles it; an abort rejects it like the real transports do.
export function createControlledTransport(): ControlledTransport {
  const started: PendingUpload[] = [];
  let inFlight = 0;
  let maxInFlight = 0;
  return {
    started,
    get inFlight() {
      return inFlight;
    },
    get maxInFlight() {
      return maxInFlight;
    },
    transport: {
      upload: (target, file, onProgress, signal) =>
        new Promise<void>((resolve, reject) => {
          inFlight += 1;
          maxInFlight = Math.max(maxInFlight, inFlight);
          let done = false;
          const finish = (action: () => void): void => {
            if (done) return;
            done = true;
            inFlight -= 1;
            action();
          };
          started.push({
            target,
            file,
            onProgress,
            signal,
            resolve: () => finish(resolve),
            reject: (error) => finish(() => reject(error)),
          });
          signal.addEventListener('abort', () => finish(() => reject(new UploadAbortedError())), { once: true });
        }),
    },
  };
}
