import type { MediaType } from '@rs/shared';

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

// The browser leaves File.type empty for some files (HEIC, MOV on some systems): fall back to the extension.
export function detectMimeType(file: Pick<File, 'name' | 'type'>): string | null {
  const reported = file.type.trim().toLowerCase();
  return reported !== '' ? reported : (MIME_BY_EXTENSION[extensionOf(file.name)] ?? null);
}

export function mediaTypeOf(mimeType: string | null): MediaType | null {
  if (mimeType === null) return null;
  if (mimeType.startsWith('image/')) return 'image';
  if (mimeType.startsWith('video/')) return 'video';
  return null;
}

// The File with its type set to what was detected, so the multipart part never goes out untyped.
export function withMimeType(file: File, mimeType: string): File {
  if (file.type === mimeType) return file;
  return new File([file], file.name, { type: mimeType, lastModified: file.lastModified });
}
