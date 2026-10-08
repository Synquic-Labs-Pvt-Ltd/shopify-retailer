import { describe, expect, it } from 'vitest';
import { createDraftStore } from '@/lib/state/draft';
import { createMemoryStorage } from '@/lib/state/draftStorage';
import type { ReferenceTarget } from '@/lib/state/draftTypes';
import { createFileRegistry } from '@/lib/state/fileRegistry';
import { addFiles, summarizeProblems, type AddFilesDeps } from './addFiles';
import type { ImageDecoder } from './prepareImage';
import type { LoadedVideo, VideoLoader } from './readVideo';
import { createFakeMediaApi, flush, LIMITS, makeFile, slot } from './testkit';
import type { UploadTransport } from './transport';
import { createUploadService } from './uploadService';

const GID = 'gid://shopify/Product/1';
const COMMON: ReferenceTarget = { kind: 'common' };
const MB = 1024 * 1024;

interface DecoderOptions {
  width?: number;
  height?: number;
  encodedBytes?: number;
  failFor?: string;
  gate?: Promise<void>;
}

function fakeImages(options: DecoderOptions = {}): ImageDecoder & { active: number; maxActive: number } {
  const { width = 1000, height = 800, encodedBytes = 700 } = options;
  const decoder = {
    active: 0,
    maxActive: 0,
    decode: async (blob: Blob) => {
      decoder.active += 1;
      decoder.maxActive = Math.max(decoder.maxActive, decoder.active);
      await options.gate;
      if (options.failFor !== undefined && (blob as File).name === options.failFor) {
        decoder.active -= 1;
        throw new Error('cannot decode');
      }
      return {
        width,
        height,
        toJpeg: async () => new Blob([new Uint8Array(encodedBytes)], { type: 'image/jpeg' }),
        thumbnail: async () => 'data:image/jpeg;base64,THUMB',
        close: () => {
          decoder.active -= 1;
        },
      };
    },
  };
  return decoder;
}

function fakeVideos(durations: Record<string, number>): VideoLoader {
  return {
    load: async (blob) => {
      const duration = durations[(blob as File).name];
      if (duration === undefined) throw new Error('codec');
      const loaded: LoadedVideo = {
        durationSec: duration,
        width: 720,
        height: 1280,
        capturePoster: async () => 'data:image/jpeg;base64,POSTER',
        dispose: () => undefined,
      };
      return loaded;
    },
  };
}

const instant: UploadTransport = { upload: () => Promise.resolve() };

function setup(options: { images?: ImageDecoder; durations?: Record<string, number> } = {}) {
  const files = createFileRegistry();
  const store = createDraftStore({ storage: createMemoryStorage(), files });
  const media = createFakeMediaApi();
  const service = createUploadService({ draft: store, files, api: media.api, transport: instant });
  let counter = 0;
  const deps: AddFilesDeps = {
    draft: store,
    files,
    uploads: service,
    images: options.images ?? fakeImages(),
    videos: fakeVideos(options.durations ?? {}),
    newId: () => `slot-${(counter += 1)}`,
  };
  const refs = (target: ReferenceTarget = COMMON) =>
    target.kind === 'common' ? store.getState().commonRefs : (store.getState().productRefs[target.productId] ?? []);
  return { files, store, media, service, deps, refs };
}

describe('addFiles', () => {
  it('adds an image slot, downscales it and uploads it', async () => {
    const images = fakeImages({ width: 4000, height: 3000, encodedBytes: 700 });
    const { deps, refs, media, files } = setup({ images });
    const result = await addFiles(COMMON, [makeFile('photo.png', 'image/png', 5000)], LIMITS, deps);
    expect(result).toMatchObject({ added: ['slot-1'], problems: [], uploads: { failed: 0, blocked: false } });
    expect(refs()[0]).toMatchObject({
      clientId: 'slot-1',
      mediaType: 'image',
      filename: 'photo.jpg',
      mimeType: 'image/jpeg',
      fileSize: 700,
      status: 'processing',
      mediaId: 'media-1',
      previewUrl: 'data:image/jpeg;base64,THUMB',
    });
    expect(media.createCalls[0]?.files[0]).toMatchObject({ filename: 'photo.jpg', fileSize: 700, scope: 'common' });
    expect(files.get('slot-1')?.type).toBe('image/jpeg');
  });

  it('keeps a small image as it is', async () => {
    const { deps, refs } = setup();
    const original = makeFile('small.webp', 'image/webp', 4321);
    await addFiles({ kind: 'product', productId: GID }, [original], LIMITS, deps);
    expect(refs({ kind: 'product', productId: GID })[0]).toMatchObject({
      filename: 'small.webp',
      mimeType: 'image/webp',
      fileSize: 4321,
    });
    expect(deps.files.get('slot-1')).toBe(original);
  });

  it('adds a video with its duration and poster', async () => {
    const { deps, refs, media } = setup({ durations: { 'clip.mp4': 12.5 } });
    const result = await addFiles(COMMON, [makeFile('clip.mp4', 'video/mp4', 9000)], LIMITS, deps);
    expect(result.problems).toEqual([]);
    expect(refs()[0]).toMatchObject({
      mediaType: 'video',
      durationSec: 12.5,
      previewUrl: 'data:image/jpeg;base64,POSTER',
      status: 'processing',
    });
    expect(media.createCalls[0]?.files[0]).toMatchObject({ mimeType: 'video/mp4', durationSec: 12.5 });
  });

  it('skips files that break the rules and still adds the rest', async () => {
    const { deps, refs, media } = setup({ durations: { 'long.mp4': 61, 'ok.mp4': 10 } });
    const result = await addFiles(
      COMMON,
      [
        makeFile('a.heic', 'image/heic'),
        makeFile('long.mp4', 'video/mp4'),
        makeFile('broken.mp4', 'video/mp4'),
        makeFile('notes.pdf', 'application/pdf'),
        makeFile('good.jpg', 'image/jpeg'),
        makeFile('ok.mp4', 'video/mp4'),
      ],
      LIMITS,
      deps,
    );
    expect(result.problems).toEqual([
      'a.heic: Convert it to JPEG first, browsers cannot read HEIC.',
      'long.mp4: A video is longer than 60 seconds.',
      'broken.mp4: The length of this video could not be read.',
      'notes.pdf: Unsupported file type. Use JPEG, PNG, WebP, MP4 or MOV.',
    ]);
    expect(refs().map((ref) => ref.filename)).toEqual(['good.jpg', 'ok.mp4']);
    expect(result.added).toHaveLength(2);
    expect(media.createCalls).toHaveLength(1);
  });

  it('does not read a video that already fails on size', async () => {
    const { deps } = setup({ durations: {} });
    const huge = { name: 'huge.mp4', type: 'video/mp4', size: 101 * MB } as File;
    const result = await addFiles(COMMON, [huge], LIMITS, deps);
    expect(result.problems).toEqual(['huge.mp4: A video is larger than 100 MB.']);
  });

  it('adds only as many files as fit and says so', async () => {
    const { deps, refs, store } = setup();
    for (const id of ['x1', 'x2', 'x3', 'x4']) {
      store.getState().addRef({ kind: 'product', productId: GID }, slot(id, { status: 'ready', mediaId: id }));
    }
    const files = ['1', '2', '3'].map((n) => makeFile(`f${n}.jpg`, 'image/jpeg'));
    const result = await addFiles({ kind: 'product', productId: GID }, files, LIMITS, deps);
    expect(result.problems).toEqual(['Each product can have up to 5 photos.']);
    expect(result.added).toHaveLength(1);
    expect(refs({ kind: 'product', productId: GID })).toHaveLength(5);
  });

  it('does nothing but explain when the list is full', async () => {
    const { deps, media } = setup();
    const result = await addFiles(COMMON, [makeFile('a.jpg', 'image/jpeg')], { ...LIMITS, maxCommon: 0 }, deps);
    expect(result).toMatchObject({ added: [], problems: ['You can add up to 0 style references.'] });
    expect(media.createCalls).toHaveLength(0);
  });

  it('drops the slot of an image that cannot be decoded and uploads the others', async () => {
    const { deps, refs, media } = setup({ images: fakeImages({ failFor: 'bad.jpg' }) });
    const result = await addFiles(
      COMMON,
      [makeFile('bad.jpg', 'image/jpeg'), makeFile('good.jpg', 'image/jpeg')],
      LIMITS,
      deps,
    );
    expect(result.problems).toEqual(['bad.jpg: The image could not be processed.']);
    expect(refs().map((ref) => ref.filename)).toEqual(['good.jpg']);
    expect(deps.files.has('slot-1')).toBe(false);
    expect(media.createCalls[0]?.files).toHaveLength(1);
  });

  it('rejects an image that is still too large after downscaling', async () => {
    const images = fakeImages({ width: 4000, height: 3000, encodedBytes: 2 * MB });
    const { deps, refs } = setup({ images });
    const tight = { ...LIMITS, maxImageMB: 1 };
    const result = await addFiles(COMMON, [makeFile('big.jpg', 'image/jpeg', 3000)], tight, deps);
    expect(result.problems).toEqual(['big.jpg: An image is larger than 1 MB.']);
    expect(refs()).toEqual([]);
    expect(result.added).toEqual([]);
  });

  it('does not upload a slot that was removed while its image was being prepared', async () => {
    let open: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      open = resolve;
    });
    const { deps, refs, service, media } = setup({ images: fakeImages({ gate }) });
    const pending = addFiles(COMMON, [makeFile('a.jpg', 'image/jpeg'), makeFile('b.jpg', 'image/jpeg')], LIMITS, deps);
    await flush();
    expect(refs()).toHaveLength(2);
    service.remove('slot-1');
    open();
    const result = await pending;
    expect(result.added).toEqual(['slot-2']);
    expect(media.createCalls[0]?.files.map((file) => file.clientId)).toEqual(['slot-2']);
  });

  it('prepares at most two images at a time', async () => {
    const images = fakeImages();
    const { deps } = setup({ images });
    const picked = Array.from({ length: 6 }, (_, index) => makeFile(`f${index}.jpg`, 'image/jpeg'));
    await addFiles(COMMON, picked, LIMITS, deps);
    expect(images.maxActive).toBe(2);
  });
});

describe('summarizeProblems', () => {
  it('shows the first problem and counts the rest', () => {
    expect(summarizeProblems([])).toBe('');
    expect(summarizeProblems(['a.heic: Convert it.'])).toBe('a.heic: Convert it.');
    expect(summarizeProblems(['a: x', 'b: y', 'c: z'])).toBe('a: x (and 2 more problems)');
  });
});
