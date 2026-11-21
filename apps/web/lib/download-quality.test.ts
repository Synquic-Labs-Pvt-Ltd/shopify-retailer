import { describe, expect, it, vi } from 'vitest';
import {
  STANDARD_JPEG_QUALITY,
  STANDARD_MAX_EDGE,
  convertToStandardJpeg,
  isJpegName,
  jpegFilename,
  originalImageUrl,
  parseDownloadQuality,
} from './download-quality';
import type { ImageDecoder } from './references/prepareImage';

describe('parseDownloadQuality', () => {
  it('reads only a saved "original" as original, and everything else as the standard default', () => {
    expect(parseDownloadQuality('original')).toBe('original');
    expect(parseDownloadQuality('standard')).toBe('standard');
    expect(parseDownloadQuality(null)).toBe('standard');
    expect(parseDownloadQuality('')).toBe('standard');
    expect(parseDownloadQuality('ORIGINAL')).toBe('standard');
    expect(parseDownloadQuality('{"quality":"original"}')).toBe('standard');
  });
});

describe('file names', () => {
  it('swaps the extension for .jpg and adds one when there is none', () => {
    expect(jpegFilename('Shirt-Front-1.png')).toBe('Shirt-Front-1.jpg');
    expect(jpegFilename('a.b.webp')).toBe('a.b.jpg');
    expect(jpegFilename('shot')).toBe('shot.jpg');
    expect(jpegFilename('.hidden')).toBe('.hidden.jpg');
  });

  it('knows a JPEG name', () => {
    expect(['a.jpg', 'a.JPG', 'a.jpeg', 'a.JPEG'].every(isJpegName)).toBe(true);
    expect(['a.png', 'a.webp', 'a.jpg.png', 'jpg'].some(isJpegName)).toBe(false);
  });
});

describe('convertToStandardJpeg', () => {
  const source = new Blob(['png bytes'], { type: 'image/png' });

  function decoder(overrides: { width?: number; height?: number; type?: string } = {}) {
    const close = vi.fn();
    const toJpeg = vi.fn(async () => new Blob(['jpeg bytes'], { type: overrides.type ?? 'image/jpeg' }));
    const decode = vi.fn(async () => ({
      width: overrides.width ?? 1024,
      height: overrides.height ?? 1536,
      toJpeg,
      thumbnail: vi.fn(async () => null),
      close,
    }));
    return { close, decode, toJpeg, decoder: { decode } satisfies ImageDecoder };
  }

  it('encodes a JPEG at the standard quality and releases the decoded image', async () => {
    const fake = decoder();
    const result = await convertToStandardJpeg(source, fake.decoder);
    expect(result.type).toBe('image/jpeg');
    expect(await result.text()).toBe('jpeg bytes');
    expect(fake.decode).toHaveBeenCalledWith(source);
    expect(fake.toJpeg).toHaveBeenCalledWith(1024, 1536, STANDARD_JPEG_QUALITY);
    expect(fake.close).toHaveBeenCalledTimes(1);
  });

  it('uses the preset of the reference uploads: 2048 px on the longest edge, quality 0.9', () => {
    expect(STANDARD_MAX_EDGE).toBe(2048);
    expect(STANDARD_JPEG_QUALITY).toBe(0.9);
  });

  it('scales a large image down to the longest edge limit and never enlarges a small one', async () => {
    const large = decoder({ width: 4096, height: 3072 });
    await convertToStandardJpeg(source, large.decoder);
    expect(large.toJpeg).toHaveBeenCalledWith(2048, 1536, STANDARD_JPEG_QUALITY);

    const small = decoder({ width: 640, height: 480 });
    await convertToStandardJpeg(source, small.decoder);
    expect(small.toJpeg).toHaveBeenCalledWith(640, 480, STANDARD_JPEG_QUALITY);
  });

  it('throws when the browser answers with another type, and still releases the decoded image', async () => {
    const fake = decoder({ type: 'image/png' });
    await expect(convertToStandardJpeg(source, fake.decoder)).rejects.toThrow(/instead of a JPEG/);
    expect(fake.close).toHaveBeenCalledTimes(1);
  });

  it('throws for an image without a size, and when decoding fails', async () => {
    const empty = decoder({ width: 0, height: 0 });
    await expect(convertToStandardJpeg(source, empty.decoder)).rejects.toThrow(/no size/);
    expect(empty.toJpeg).not.toHaveBeenCalled();
    expect(empty.close).toHaveBeenCalledTimes(1);

    const broken: ImageDecoder = { decode: () => Promise.reject(new Error('cannot decode')) };
    await expect(convertToStandardJpeg(source, broken)).rejects.toThrow('cannot decode');
  });

  it('has no browser to convert with in plain Node, which is the case where the caller keeps the original', async () => {
    await expect(convertToStandardJpeg(source)).rejects.toThrow();
  });
});

describe('originalImageUrl', () => {
  const CDN = 'https://cdn.shopify.com/s/files/1/0624/0701/6704/files/rs-lehenga-img2.png?v=1795255247';

  it('asks for the PNG itself when the stored file is a PNG, keeping the version parameter', () => {
    expect(originalImageUrl(CDN, 'Lehenga-Festive-2.png')).toBe(`${CDN}&format=png`);
    expect(originalImageUrl(CDN, 'Lehenga-Festive-2.PNG')).toBe(`${CDN}&format=png`);
  });

  it('works for a URL without a query and does not stack the parameter', () => {
    const bare = 'https://cdn.shopify.com/s/files/x/rs-img1.png';
    expect(originalImageUrl(bare, 'a.png')).toBe(`${bare}?format=png`);
    const once = originalImageUrl(CDN, 'a.png');
    expect(originalImageUrl(once, 'a.png')).toBe(once);
    expect(originalImageUrl('https://cdn.shopify.com/s/files/x/rs-img1.png?format=pjpg&v=1', 'a.png')).toBe('https://cdn.shopify.com/s/files/x/rs-img1.png?format=png&v=1');
  });

  it('leaves every other file alone: JPEGs, videos and URLs that cannot be read', () => {
    expect(originalImageUrl('https://cdn.shopify.com/s/files/x/rs-img1.jpg?v=1', 'a.jpg')).toBe('https://cdn.shopify.com/s/files/x/rs-img1.jpg?v=1');
    expect(originalImageUrl('https://cdn.shopify.com/s/files/x/clip.mp4?v=1', 'clip.mp4')).toBe('https://cdn.shopify.com/s/files/x/clip.mp4?v=1');
    expect(originalImageUrl('not a url', 'a.png')).toBe('not a url');
  });
});
