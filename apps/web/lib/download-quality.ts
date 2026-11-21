// "Standard" and "original" downloads of generated images.
//
// The file stored in Shopify is the original: exactly what the image model returned, never resized or re-encoded by
// the app. "Original" saves that file as it is. "Standard" saves a smaller web-optimized JPEG made in the browser
// from it, so nothing extra is stored and images generated earlier get both versions too. Only images are converted:
// a file that is already a JPEG (re-encoding would only lose quality) and every video are saved as they are.

import { browserImageDecoder } from './references/browserImage';
import { JPEG_QUALITY, MAX_LONG_EDGE, computeTargetSize, type ImageDecoder } from './references/prepareImage';

export type DownloadQuality = 'standard' | 'original';

export const DEFAULT_DOWNLOAD_QUALITY: DownloadQuality = 'standard';
export const DOWNLOAD_QUALITY_STORAGE_KEY = 'rs.downloadQuality';

// Anything but a stored "original" reads as the default, so a damaged or old value never breaks the page.
export function parseDownloadQuality(raw: string | null): DownloadQuality {
  return raw === 'original' ? 'original' : DEFAULT_DOWNLOAD_QUALITY;
}

// A standard JPEG uses the same preset as the images merchants upload as references: 2048 px on the longest edge at
// most (larger images are scaled down, smaller ones are never enlarged), JPEG quality 0.9.
export const STANDARD_MAX_EDGE = MAX_LONG_EDGE;
export const STANDARD_JPEG_QUALITY = JPEG_QUALITY;

const JPEG_NAME = /\.jpe?g$/i;

export function isJpegName(filename: string): boolean {
  return JPEG_NAME.test(filename);
}

// "shirt-front-1.png" -> "shirt-front-1.jpg". A name without an extension gets one.
export function jpegFilename(filename: string): string {
  const dot = filename.lastIndexOf('.');
  const base = dot > 0 ? filename.slice(0, dot) : filename;
  return `${base}.jpg`;
}

export type ImageConverter = (blob: Blob) => Promise<Blob>;

// The image as a standard JPEG, drawn on white (a JPEG has no transparency). Throws when the browser cannot decode or
// encode it, or answers with something other than a JPEG: the caller then keeps the original.
export async function convertToStandardJpeg(blob: Blob, decoder: ImageDecoder = browserImageDecoder): Promise<Blob> {
  const image = await decoder.decode(blob);
  try {
    if (!(image.width > 0 && image.height > 0)) throw new Error('The image has no size');
    const { width, height } = computeTargetSize(image.width, image.height, STANDARD_MAX_EDGE);
    const jpeg = await image.toJpeg(width, height, STANDARD_JPEG_QUALITY);
    if (jpeg.type !== 'image/jpeg') throw new Error(`The browser produced ${jpeg.type || 'an unknown type'} instead of a JPEG`);
    return jpeg;
  } finally {
    image.close();
  }
}
