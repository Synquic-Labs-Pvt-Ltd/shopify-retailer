import { describe, expect, it } from 'vitest';
import { detectMimeType, extensionOf, replaceExtension } from './fileTypes';
import { checkPreparedSize, limitMessage, remainingRoom, validateFile } from './limits';
import { LIMITS, slot } from './testkit';

const MB = 1024 * 1024;

function pick(name: string, type: string, size = 1000) {
  return { name, type, size };
}

describe('validateFile', () => {
  it('accepts the allowed images and reports the media type and mime type', () => {
    for (const [name, type] of [
      ['a.jpg', 'image/jpeg'],
      ['a.png', 'image/png'],
      ['a.webp', 'image/webp'],
    ] as const) {
      expect(validateFile(pick(name, type), { durationSec: null }, LIMITS)).toEqual({
        ok: true,
        mediaType: 'image',
        mimeType: type,
      });
    }
  });

  it('does not size-check images here: they are downscaled first', () => {
    expect(validateFile(pick('big.jpg', 'image/jpeg', 80 * MB), { durationSec: null }, LIMITS).ok).toBe(true);
  });

  it('tells the merchant to convert HEIC, by type or by extension', () => {
    for (const file of [pick('a.heic', 'image/heic'), pick('a.HEIC', ''), pick('a.heif', 'image/heif')]) {
      expect(validateFile(file, { durationSec: null }, LIMITS)).toEqual({
        ok: false,
        reason: 'Convert it to JPEG first, browsers cannot read HEIC.',
      });
    }
  });

  it('rejects other image formats and unknown files with the allowed list', () => {
    expect(validateFile(pick('a.gif', 'image/gif'), { durationSec: null }, LIMITS)).toEqual({
      ok: false,
      reason: 'Unsupported image format. Use JPEG, PNG or WebP.',
    });
    expect(validateFile(pick('a.pdf', 'application/pdf'), { durationSec: null }, LIMITS)).toEqual({
      ok: false,
      reason: 'Unsupported file type. Use JPEG, PNG, WebP, MP4 or MOV.',
    });
    expect(validateFile(pick('mystery', ''), { durationSec: null }, LIMITS).ok).toBe(false);
  });

  it('rejects an empty file', () => {
    expect(validateFile(pick('a.jpg', 'image/jpeg', 0), { durationSec: null }, LIMITS)).toEqual({
      ok: false,
      reason: 'The file is empty.',
    });
  });

  it('accepts a video within the limits, typed by extension when the browser gives no type', () => {
    expect(validateFile(pick('a.mp4', 'video/mp4'), { durationSec: 12 }, LIMITS)).toEqual({
      ok: true,
      mediaType: 'video',
      mimeType: 'video/mp4',
    });
    expect(validateFile(pick('clip.MOV', ''), { durationSec: 60 }, LIMITS)).toEqual({
      ok: true,
      mediaType: 'video',
      mimeType: 'video/quicktime',
    });
  });

  it('rejects videos of another format, too large, too long or of unknown length', () => {
    expect(validateFile(pick('a.avi', 'video/x-msvideo'), { durationSec: 5 }, LIMITS)).toEqual({
      ok: false,
      reason: 'Unsupported video format. Use MP4 or MOV.',
    });
    expect(validateFile(pick('a.mp4', 'video/mp4', 100 * MB + 1), { durationSec: 5 }, LIMITS)).toEqual({
      ok: false,
      reason: 'A video is larger than 100 MB.',
    });
    expect(validateFile(pick('a.mp4', 'video/mp4'), { durationSec: 60.5 }, LIMITS)).toEqual({
      ok: false,
      reason: 'A video is longer than 60 seconds.',
    });
    expect(validateFile(pick('a.mp4', 'video/mp4'), { durationSec: null }, LIMITS)).toEqual({
      ok: false,
      reason: 'The length of this video could not be read.',
    });
  });
});

describe('checkPreparedSize', () => {
  it('measures images and videos against their own limits', () => {
    expect(checkPreparedSize(20 * MB, 'image', LIMITS)).toBeNull();
    expect(checkPreparedSize(20 * MB + 1, 'image', LIMITS)).toBe('An image is larger than 20 MB.');
    expect(checkPreparedSize(50 * MB, 'video', LIMITS)).toBeNull();
    expect(checkPreparedSize(0, 'image', LIMITS)).toBe('The file could not be read.');
  });
});

describe('remainingRoom and limitMessage', () => {
  const full = 'gid://shopify/Product/1';
  const draft = {
    commonRefs: [slot('c1'), slot('c2')],
    productRefs: { [full]: [slot('p1'), slot('p2'), slot('p3'), slot('p4'), slot('p5')] },
  };

  it('counts what is left per target', () => {
    expect(remainingRoom({ kind: 'common' }, LIMITS, draft)).toBe(8);
    expect(remainingRoom({ kind: 'product', productId: full }, LIMITS, draft)).toBe(0);
    expect(remainingRoom({ kind: 'product', productId: 'gid://shopify/Product/2' }, LIMITS, draft)).toBe(5);
    expect(remainingRoom({ kind: 'common' }, { ...LIMITS, maxCommon: 1 }, draft)).toBe(0);
  });

  it('names the limit', () => {
    expect(limitMessage({ kind: 'common' }, LIMITS)).toBe('You can add up to 10 style references.');
    expect(limitMessage({ kind: 'product', productId: 'x' }, LIMITS)).toBe('Each product can have up to 5 photos.');
  });
});

describe('file types', () => {
  it('detects the mime type, preferring what the browser reports', () => {
    expect(detectMimeType({ name: 'a.png', type: 'IMAGE/JPEG' })).toBe('image/jpeg');
    expect(detectMimeType({ name: 'a.png', type: '' })).toBe('image/png');
    expect(detectMimeType({ name: 'a.xyz', type: '' })).toBeNull();
  });

  it('handles extensions', () => {
    expect(extensionOf('photo.final.JPG')).toBe('jpg');
    expect(extensionOf('noext')).toBe('');
    expect(replaceExtension('photo.final.png', 'jpg')).toBe('photo.final.jpg');
    expect(replaceExtension('noext', 'jpg')).toBe('noext.jpg');
    expect(replaceExtension('.hidden', 'jpg')).toBe('.hidden.jpg');
  });
});
