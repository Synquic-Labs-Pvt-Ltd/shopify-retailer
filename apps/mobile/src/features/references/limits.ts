import type { MediaType, ReferencesConfig } from '@rs/shared';
import { isHeic, type PickedAsset } from './pickedAsset';

// The limits come from GET /me (generation.references); the server enforces the same ones again.
export type ReferenceLimits = ReferencesConfig;

const MB = 1024 * 1024;

const TYPE_LABELS: Record<string, string> = {
  'image/jpeg': 'JPEG',
  'image/png': 'PNG',
  'image/webp': 'WebP',
  'video/mp4': 'MP4',
  'video/quicktime': 'MOV',
};

function typeList(mimeTypes: readonly string[]): string {
  const labels = mimeTypes.map((type) => TYPE_LABELS[type] ?? type.split('/')[1]?.toUpperCase() ?? type);
  return labels.length < 2 ? labels.join('') : `${labels.slice(0, -1).join(', ')} or ${labels[labels.length - 1]}`;
}

// How many more references fit into a list that holds `current` of them.
export function remainingSlots(max: number, current: number): number {
  return Math.max(0, max - current);
}

// A clear sentence when the file cannot be used, otherwise null. HEIC and HEIF pass because they are converted
// to JPEG before upload; the size is checked again afterwards (see checkPreparedSize).
export function validateAsset(asset: PickedAsset, limits: ReferenceLimits): string | null {
  const mime = asset.mimeType;
  if (asset.mediaType === 'video') {
    if (mime === null || !limits.videoMimeTypes.includes(mime)) {
      return `Unsupported video format. Use ${typeList(limits.videoMimeTypes)}.`;
    }
    if (asset.fileSize !== null && asset.fileSize > limits.maxVideoMB * MB) {
      return `A video is larger than ${limits.maxVideoMB} MB.`;
    }
    if (asset.durationSec !== null && asset.durationSec > limits.maxVideoSeconds) {
      return `A video is longer than ${limits.maxVideoSeconds} seconds.`;
    }
    return null;
  }
  if (mime === null || (!limits.imageMimeTypes.includes(mime) && !isHeic(mime))) {
    return `Unsupported image format. Use ${typeList(limits.imageMimeTypes)}.`;
  }
  return null;
}

// Checks the size of the file that will really be uploaded (an image after conversion and downscaling).
export function checkPreparedSize(bytes: number, mediaType: MediaType, limits: ReferenceLimits): string | null {
  if (bytes <= 0) return 'A file could not be read.';
  const maxMB = mediaType === 'video' ? limits.maxVideoMB : limits.maxImageMB;
  return bytes > maxMB * MB ? `${mediaType === 'video' ? 'A video' : 'An image'} is larger than ${maxMB} MB.` : null;
}
