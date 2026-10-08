import type { MediaType, ReferencesConfig } from '@rs/shared';
import type { DraftData, ReferenceTarget } from '@/lib/state/draftTypes';
import { refsOf } from '@/lib/state/draftData';
import { detectMimeType, isHeic, mediaTypeOf } from './fileTypes';

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

export type FileCheck =
  | { ok: true; mediaType: MediaType; mimeType: string }
  | { ok: false; reason: string };

export interface FileMeta {
  // Videos only. null when the browser could not read the length.
  durationSec: number | null;
}

// A sentence for the user when the picked file cannot be used. Images pass the size check here on purpose:
// they are downscaled first, so only the prepared file is measured (see checkPreparedSize).
export function validateFile(
  file: Pick<File, 'name' | 'type' | 'size'>,
  meta: FileMeta,
  limits: ReferenceLimits,
): FileCheck {
  const mimeType = detectMimeType(file);
  if (isHeic(mimeType)) return { ok: false, reason: 'Convert it to JPEG first, browsers cannot read HEIC.' };
  const mediaType = mediaTypeOf(mimeType);
  if (mimeType === null || mediaType === null) {
    const allowed = typeList([...limits.imageMimeTypes, ...limits.videoMimeTypes]);
    return { ok: false, reason: `Unsupported file type. Use ${allowed}.` };
  }
  if (file.size <= 0) return { ok: false, reason: 'The file is empty.' };

  if (mediaType === 'image') {
    return limits.imageMimeTypes.includes(mimeType)
      ? { ok: true, mediaType, mimeType }
      : { ok: false, reason: `Unsupported image format. Use ${typeList(limits.imageMimeTypes)}.` };
  }
  if (!limits.videoMimeTypes.includes(mimeType)) {
    return { ok: false, reason: `Unsupported video format. Use ${typeList(limits.videoMimeTypes)}.` };
  }
  if (file.size > limits.maxVideoMB * MB) {
    return { ok: false, reason: `A video is larger than ${limits.maxVideoMB} MB.` };
  }
  if (meta.durationSec === null) return { ok: false, reason: 'The length of this video could not be read.' };
  if (meta.durationSec > limits.maxVideoSeconds) {
    return { ok: false, reason: `A video is longer than ${limits.maxVideoSeconds} seconds.` };
  }
  return { ok: true, mediaType, mimeType };
}

// Checks the size of the file that will really be uploaded (an image after downscaling).
export function checkPreparedSize(bytes: number, mediaType: MediaType, limits: ReferenceLimits): string | null {
  if (bytes <= 0) return 'The file could not be read.';
  const maxMB = mediaType === 'video' ? limits.maxVideoMB : limits.maxImageMB;
  return bytes > maxMB * MB ? `${mediaType === 'video' ? 'A video' : 'An image'} is larger than ${maxMB} MB.` : null;
}

export function maxFor(target: ReferenceTarget, limits: ReferenceLimits): number {
  return target.kind === 'common' ? limits.maxCommon : limits.maxPerProduct;
}

// How many more references fit into the target's list.
export function remainingRoom(
  target: ReferenceTarget,
  limits: ReferenceLimits,
  draft: Pick<DraftData, 'commonRefs' | 'productRefs'>,
): number {
  return Math.max(0, maxFor(target, limits) - refsOf(draft, target).length);
}

export function limitMessage(target: ReferenceTarget, limits: ReferenceLimits): string {
  return target.kind === 'common'
    ? `You can add up to ${limits.maxCommon} common references.`
    : `Each product can have up to ${limits.maxPerProduct} references.`;
}
