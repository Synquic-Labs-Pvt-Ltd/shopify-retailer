import { describe, expect, it } from 'vitest';
import {
  computeTargetSize,
  JPEG_QUALITY,
  MAX_LONG_EDGE,
  prepareImage,
  type DecodedImage,
  type ImageDecoder,
} from './prepareImage';
import { makeFile } from './testkit';

describe('computeTargetSize', () => {
  it('leaves an image within the long edge alone', () => {
    expect(computeTargetSize(2048, 1000, 2048)).toEqual({ width: 2048, height: 1000, scaled: false });
    expect(computeTargetSize(800, 600, 2048)).toEqual({ width: 800, height: 600, scaled: false });
  });

  it('scales the long edge down to the maximum and keeps the ratio', () => {
    expect(computeTargetSize(4096, 2048, 2048)).toEqual({ width: 2048, height: 1024, scaled: true });
    expect(computeTargetSize(3000, 4000, 2048)).toEqual({ width: 1536, height: 2048, scaled: true });
    expect(computeTargetSize(6000, 4000, 2048)).toEqual({ width: 2048, height: 1365, scaled: true });
  });

  it('never produces a zero side', () => {
    expect(computeTargetSize(100000, 10, 2048)).toEqual({ width: 2048, height: 1, scaled: true });
  });

  it('ignores a degenerate size', () => {
    expect(computeTargetSize(0, 0, 2048)).toEqual({ width: 0, height: 0, scaled: false });
  });
});

interface Calls {
  encoded: { width: number; height: number; quality: number }[];
  closed: number;
}

function fakeDecoder(width: number, height: number, options: { failEncode?: boolean } = {}) {
  const calls: Calls = { encoded: [], closed: 0 };
  const decoder: ImageDecoder = {
    decode: async () => {
      const image: DecodedImage = {
        width,
        height,
        toJpeg: async (w, h, quality) => {
          if (options.failEncode) throw new Error('no canvas');
          calls.encoded.push({ width: w, height: h, quality });
          return new Blob([new Uint8Array(500)], { type: 'image/jpeg' });
        },
        thumbnail: async () => 'data:image/jpeg;base64,THUMB',
        close: () => {
          calls.closed += 1;
        },
      };
      return image;
    },
  };
  return { decoder, calls };
}

describe('prepareImage', () => {
  it('uploads a small jpeg, png or webp as it is', async () => {
    for (const [name, type] of [
      ['a.jpg', 'image/jpeg'],
      ['a.png', 'image/png'],
      ['a.webp', 'image/webp'],
    ] as const) {
      const { decoder, calls } = fakeDecoder(1200, 800);
      const file = makeFile(name, type, 4000);
      const prepared = await prepareImage(file, { decoder });
      expect(prepared.file).toBe(file);
      expect(prepared).toMatchObject({
        reencoded: false,
        width: 1200,
        height: 800,
        thumbnail: 'data:image/jpeg;base64,THUMB',
      });
      expect(calls.encoded).toEqual([]);
      expect(calls.closed).toBe(1);
    }
  });

  it('types a file whose browser type is empty', async () => {
    const { decoder } = fakeDecoder(100, 100);
    const prepared = await prepareImage(makeFile('a.png', '', 100), { decoder });
    expect(prepared.file.type).toBe('image/png');
    expect(prepared.reencoded).toBe(false);
  });

  it('downscales a large image to a 2048 px long edge as a jpeg at quality 0.9', async () => {
    const { decoder, calls } = fakeDecoder(4000, 3000);
    const prepared = await prepareImage(makeFile('photo.PNG', 'image/png', 9000), { decoder });
    expect(calls.encoded).toEqual([{ width: 2048, height: 1536, quality: 0.9 }]);
    expect(prepared).toMatchObject({ reencoded: true, width: 2048, height: 1536 });
    expect(prepared.file).toMatchObject({ name: 'photo.jpg', type: 'image/jpeg', size: 500 });
    expect(MAX_LONG_EDGE).toBe(2048);
    expect(JPEG_QUALITY).toBe(0.9);
  });

  it('re-encodes a file that is small in pixels but over the byte limit', async () => {
    const { decoder, calls } = fakeDecoder(1500, 1500);
    const prepared = await prepareImage(makeFile('a.png', 'image/png', 3000), { decoder, maxBytes: 2000 });
    expect(calls.encoded).toEqual([{ width: 1500, height: 1500, quality: 0.9 }]);
    expect(prepared.file.name).toBe('a.jpg');
  });

  it('re-encodes a type the server does not take but the browser can decode', async () => {
    const { decoder, calls } = fakeDecoder(500, 500);
    const prepared = await prepareImage(makeFile('a.bmp', 'image/bmp', 3000), { decoder });
    expect(calls.encoded).toHaveLength(1);
    expect(prepared.file.type).toBe('image/jpeg');
  });

  it('closes the image when encoding fails', async () => {
    const { decoder, calls } = fakeDecoder(4000, 3000, { failEncode: true });
    await expect(prepareImage(makeFile('a.jpg', 'image/jpeg'), { decoder })).rejects.toThrow('no canvas');
    expect(calls.closed).toBe(1);
  });
});
