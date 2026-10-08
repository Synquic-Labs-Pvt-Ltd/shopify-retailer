import { detectMimeType, replaceExtension, withMimeType } from './fileTypes';

// SPEC 9, before upload: an image is downscaled to a 2048 px long edge and re-encoded as JPEG at quality 0.9.
// An image that is already small, a JPEG, PNG or WebP and within the size limit is uploaded as it is, so a
// PNG keeps its alpha channel unless it has to be downscaled (then it becomes a JPEG on white).
export const MAX_LONG_EDGE = 2048;
export const JPEG_QUALITY = 0.9;
export const THUMBNAIL_EDGE = 160;

const PASSTHROUGH_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);

// A decoded image with the browser's EXIF orientation applied. Closing it frees the bitmap.
export interface DecodedImage {
  readonly width: number;
  readonly height: number;
  toJpeg(width: number, height: number, quality: number): Promise<Blob>;
  // A small JPEG data URL for the slot, or null when it cannot be drawn.
  thumbnail(maxEdge: number): Promise<string | null>;
  close(): void;
}

// The browser side (createImageBitmap + canvas) sits behind this so the logic runs under node in tests.
export interface ImageDecoder {
  decode(file: Blob): Promise<DecodedImage>;
}

export interface TargetSize {
  width: number;
  height: number;
  scaled: boolean;
}

export function computeTargetSize(width: number, height: number, maxEdge: number): TargetSize {
  const longEdge = Math.max(width, height);
  if (longEdge <= maxEdge || longEdge <= 0) return { width, height, scaled: false };
  const ratio = maxEdge / longEdge;
  return {
    width: Math.max(1, Math.round(width * ratio)),
    height: Math.max(1, Math.round(height * ratio)),
    scaled: true,
  };
}

export interface PrepareImageOptions {
  decoder: ImageDecoder;
  maxEdge?: number;
  quality?: number;
  // Re-encode when the file is bigger than this even if its pixels are small enough.
  maxBytes?: number;
}

export interface PreparedImage {
  file: File;
  width: number;
  height: number;
  thumbnail: string | null;
  reencoded: boolean;
}

export async function prepareImage(file: File, options: PrepareImageOptions): Promise<PreparedImage> {
  const { decoder, maxEdge = MAX_LONG_EDGE, quality = JPEG_QUALITY, maxBytes = Number.POSITIVE_INFINITY } = options;
  const image = await decoder.decode(file);
  try {
    const target = computeTargetSize(image.width, image.height, maxEdge);
    const thumbnail = await image.thumbnail(THUMBNAIL_EDGE);
    const mimeType = detectMimeType(file);
    if (!target.scaled && mimeType !== null && PASSTHROUGH_TYPES.has(mimeType) && file.size <= maxBytes) {
      const kept = withMimeType(file, mimeType);
      return { file: kept, width: image.width, height: image.height, thumbnail, reencoded: false };
    }
    const blob = await image.toJpeg(target.width, target.height, quality);
    const jpeg = new File([blob], replaceExtension(file.name, 'jpg'), {
      type: 'image/jpeg',
      lastModified: file.lastModified,
    });
    return { file: jpeg, width: target.width, height: target.height, thumbnail, reencoded: true };
  } finally {
    image.close();
  }
}
