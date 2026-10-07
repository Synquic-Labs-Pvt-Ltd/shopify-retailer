import type { ImagePickerAsset } from 'expo-image-picker';
import type { MediaType } from '@rs/shared';

// One file chosen in the camera or the library, normalized for validation and upload.
export interface PickedAsset {
  uri: string;
  mediaType: MediaType;
  // Lower case. Inferred from the file extension when the picker reports none.
  mimeType: string | null;
  fileName: string;
  fileSize: number | null;
  durationSec: number | null;
  width: number;
  height: number;
}

const MIME_BY_EXTENSION: Record<string, string> = {
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
  heic: 'image/heic',
  heif: 'image/heif',
  mp4: 'video/mp4',
  mov: 'video/quicktime',
};

const HEIC_MIME_TYPES = ['image/heic', 'image/heif', 'image/heic-sequence', 'image/heif-sequence'];

export function isHeic(mimeType: string | null): boolean {
  return mimeType !== null && HEIC_MIME_TYPES.includes(mimeType);
}

export function extensionOf(name: string): string {
  const dot = name.lastIndexOf('.');
  return dot < 0 ? '' : name.slice(dot + 1).toLowerCase();
}

export function replaceExtension(name: string, extension: string): string {
  const dot = name.lastIndexOf('.');
  return `${dot <= 0 ? name : name.slice(0, dot)}.${extension}`;
}

function lastSegment(uri: string): string {
  const path = uri.split('?')[0] ?? uri;
  return decodeURIComponent(path.slice(path.lastIndexOf('/') + 1));
}

export function normalizeAsset(asset: ImagePickerAsset): PickedAsset {
  const fileName = asset.fileName ?? lastSegment(asset.uri);
  const mimeType = asset.mimeType?.toLowerCase() ?? MIME_BY_EXTENSION[extensionOf(fileName)] ?? null;
  const isVideo = asset.type === 'video' || (mimeType?.startsWith('video/') ?? false);
  // The picker reports a video's length in milliseconds.
  const durationSec = isVideo && asset.duration !== undefined && asset.duration !== null ? asset.duration / 1000 : null;
  return {
    uri: asset.uri,
    mediaType: isVideo ? 'video' : 'image',
    mimeType,
    fileName: fileName === '' ? `reference-${Date.now()}` : fileName,
    fileSize: asset.fileSize ?? null,
    durationSec,
    width: asset.width,
    height: asset.height,
  };
}
