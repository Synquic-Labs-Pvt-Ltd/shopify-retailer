import { describe, expect, it } from 'vitest';
import { defaultGenerationConfig } from '@rs/shared';
import { AppError } from '../../src/core/errors';
import { validateUploadFiles, type UploadProblem } from '../../src/modules/media/limits';
import { extensionFor, referenceFilename } from '../../src/modules/media/naming';
import { imageFile, videoFile } from './kit';

const limits = defaultGenerationConfig.references;
const PRODUCT = 'gid://shopify/Product/1';
const MB = 1024 * 1024;

function problemsOf(run: () => unknown): UploadProblem[] {
  try {
    run();
  } catch (err) {
    expect(err).toBeInstanceOf(AppError);
    const appError = err as AppError;
    expect(appError.code).toBe('validation_failed');
    return (appError.details as { files: UploadProblem[] }).files;
  }
  throw new Error('expected validation to fail');
}

describe('validateUploadFiles', () => {
  it('accepts jpeg, png, webp, mp4 and mov within the limits and classifies them', () => {
    const accepted = validateUploadFiles(
      [
        imageFile('a', { mimeType: 'image/jpeg' }),
        imageFile('b', { mimeType: 'image/png' }),
        imageFile('c', { mimeType: 'image/webp' }),
        videoFile('d', { mimeType: 'video/mp4' }),
        videoFile('e', { mimeType: 'video/quicktime', durationSec: 60 }),
      ],
      limits,
    );
    expect(accepted.map((item) => item.mediaType)).toEqual(['image', 'image', 'image', 'video', 'video']);
  });

  it('is case insensitive about the mime type', () => {
    expect(validateUploadFiles([imageFile('a', { mimeType: 'IMAGE/JPEG' })], limits)[0]?.mimeType).toBe('image/jpeg');
  });

  it('rejects mime types that are not configured', () => {
    const problems = problemsOf(() =>
      validateUploadFiles([imageFile('a', { mimeType: 'image/gif' }), imageFile('b', { mimeType: 'application/pdf' }), imageFile('c', { mimeType: 'image/heic' })], limits),
    );
    expect(problems.map((problem) => [problem.clientId, problem.code])).toEqual([
      ['a', 'unsupported_mime_type'],
      ['b', 'unsupported_mime_type'],
      ['c', 'unsupported_mime_type'],
    ]);
  });

  it('rejects images and videos over their size limit and accepts exactly the limit', () => {
    expect(validateUploadFiles([imageFile('a', { fileSize: limits.maxImageMB * MB })], limits)).toHaveLength(1);
    expect(validateUploadFiles([videoFile('b', { fileSize: limits.maxVideoMB * MB })], limits)).toHaveLength(1);
    const problems = problemsOf(() =>
      validateUploadFiles([imageFile('a', { fileSize: limits.maxImageMB * MB + 1 }), videoFile('b', { fileSize: limits.maxVideoMB * MB + 1 })], limits),
    );
    expect(problems.map((problem) => [problem.clientId, problem.code])).toEqual([
      ['a', 'file_too_large'],
      ['b', 'file_too_large'],
    ]);
  });

  it('rejects a video that is too long or has no duration, and ignores the duration of an image', () => {
    expect(validateUploadFiles([videoFile('a', { durationSec: limits.maxVideoSeconds })], limits)).toHaveLength(1);
    expect(validateUploadFiles([imageFile('b', { durationSec: 9999 })], limits)).toHaveLength(1);
    const { durationSec: _omit, ...withoutDuration } = videoFile('c');
    const problems = problemsOf(() =>
      validateUploadFiles([videoFile('a', { durationSec: limits.maxVideoSeconds + 0.5 }), withoutDuration], limits),
    );
    expect(problems.map((problem) => [problem.clientId, problem.code])).toEqual([
      ['a', 'video_too_long'],
      ['c', 'duration_required'],
    ]);
  });

  it('rejects more common references than allowed in one request', () => {
    const files = Array.from({ length: limits.maxCommon + 2 }, (_, i) => imageFile(`f${i}`));
    const problems = problemsOf(() => validateUploadFiles(files, limits));
    expect(problems.map((problem) => problem.clientId)).toEqual([`f${limits.maxCommon}`, `f${limits.maxCommon + 1}`]);
    expect(problems.every((problem) => problem.code === 'too_many_files')).toBe(true);
  });

  it('counts product references per product', () => {
    const own = Array.from({ length: limits.maxPerProduct }, (_, i) => imageFile(`p${i}`, { scope: 'product', productGid: PRODUCT }));
    const other = imageFile('other', { scope: 'product', productGid: 'gid://shopify/Product/2' });
    expect(validateUploadFiles([...own, other], limits)).toHaveLength(limits.maxPerProduct + 1);

    const problems = problemsOf(() => validateUploadFiles([...own, imageFile('extra', { scope: 'product', productGid: PRODUCT }), other], limits));
    expect(problems.map((problem) => problem.clientId)).toEqual(['extra']);
  });

  it('rejects a repeated clientId', () => {
    const problems = problemsOf(() => validateUploadFiles([imageFile('a'), imageFile('a')], limits));
    expect(problems).toEqual([expect.objectContaining({ clientId: 'a', code: 'duplicate_client_id' })]);
  });

  it('reports every problem at once', () => {
    const problems = problemsOf(() =>
      validateUploadFiles([imageFile('a', { mimeType: 'image/gif' }), videoFile('b', { durationSec: 600 }), imageFile('c', { fileSize: 50 * MB })], limits),
    );
    expect(problems.map((problem) => problem.code).sort()).toEqual(['file_too_large', 'unsupported_mime_type', 'video_too_long']);
  });
});

describe('reference filenames', () => {
  it('follows rs-ref-{shortid}.{ext}', () => {
    expect(referenceFilename('image/jpeg')).toMatch(/^rs-ref-[0-9a-f]{8}\.jpg$/);
    expect(referenceFilename('video/quicktime')).toMatch(/^rs-ref-[0-9a-f]{8}\.mov$/);
    expect(referenceFilename('video/mp4')).toMatch(/\.mp4$/);
    expect(referenceFilename('image/webp')).toMatch(/\.webp$/);
  });

  it('derives an extension for other configured types', () => {
    expect(extensionFor('image/avif')).toBe('avif');
    expect(extensionFor('image/svg+xml')).toBe('svgxml');
  });

  it('is different every time', () => {
    expect(referenceFilename('image/png')).not.toBe(referenceFilename('image/png'));
  });
});
