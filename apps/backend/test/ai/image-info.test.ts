import { describe, expect, it } from 'vitest';
import { MIME_OF_FORMAT, imageFormatOf, imageSizeOf } from '../../src/modules/ai/image-info';

const be16 = (value: number): number[] => [(value >> 8) & 0xff, value & 0xff];
const be32 = (value: number): number[] => [(value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff];

// Just the header of a PNG: signature, then an IHDR chunk that opens with the width and the height.
const png = (width: number, height: number): Uint8Array =>
  Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...be32(13), 0x49, 0x48, 0x44, 0x52, ...be32(width), ...be32(height), 8, 6, 0, 0, 0]);

// A JPEG with an EXIF-like APP1 segment before the frame header, as the image models write it.
const jpeg = (width: number, height: number, sof = 0xc2): Uint8Array =>
  Uint8Array.from([
    0xff, 0xd8,
    0xff, 0xe1, ...be16(10), 69, 120, 105, 102, 0, 0, 1, 2,
    0xff, 0xdb, ...be16(4), 0, 1,
    0xff, sof, ...be16(17), 8, ...be16(height), ...be16(width), 3, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1,
  ]);

describe('imageSizeOf', () => {
  it('reads a PNG header', () => {
    expect(imageSizeOf(png(1728, 2368))).toEqual({ width: 1728, height: 2368 });
    expect(imageSizeOf(png(3456, 4736))).toEqual({ width: 3456, height: 4736 });
  });

  it('reads a baseline and a progressive JPEG after the other segments', () => {
    expect(imageSizeOf(jpeg(864, 1184, 0xc0))).toEqual({ width: 864, height: 1184 });
    expect(imageSizeOf(jpeg(864, 1184, 0xc2))).toEqual({ width: 864, height: 1184 });
  });

  it('is unknown for anything else, a cut-off header or an empty file', () => {
    expect(imageSizeOf(new Uint8Array())).toBeNull();
    expect(imageSizeOf(Uint8Array.from([1, 2, 3, 4, 5]))).toBeNull();
    expect(imageSizeOf(png(10, 10).subarray(0, 20))).toBeNull();
    expect(imageSizeOf(jpeg(10, 10).subarray(0, 12))).toBeNull();
    expect(imageSizeOf(png(0, 100))).toBeNull();
    expect(imageSizeOf(Uint8Array.from([0xff, 0xd8, 0xff, 0xc4, 0, 0, 0, 0]))).toBeNull();
  });
});

describe('imageFormatOf', () => {
  it('tells PNG and JPEG apart by their first bytes, whatever the file is called', () => {
    expect(imageFormatOf(png(10, 10))).toBe('png');
    expect(imageFormatOf(jpeg(10, 10))).toBe('jpeg');
    expect(imageFormatOf(jpeg(10, 10, 0xc0))).toBe('jpeg');
    expect(MIME_OF_FORMAT).toEqual({ png: 'image/png', jpeg: 'image/jpeg' });
  });

  it('is unknown for anything else, including a file that is too short to tell', () => {
    expect(imageFormatOf(new Uint8Array())).toBeNull();
    expect(imageFormatOf(Uint8Array.from([0xff, 0xd8]))).toBeNull();
    expect(imageFormatOf(png(10, 10).subarray(0, 7))).toBeNull();
    expect(imageFormatOf(Uint8Array.from([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0]))).toBeNull(); // WebP
  });
});
