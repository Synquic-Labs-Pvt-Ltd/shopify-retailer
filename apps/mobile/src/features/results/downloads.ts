import { File, Paths } from 'expo-file-system';
import * as MediaLibrary from 'expo-media-library';
import * as Sharing from 'expo-sharing';
import { Platform } from 'react-native';
import type { MediaObject } from '@rs/shared';

// SPEC 16.3: download the CDN url to the cache, then save it to the gallery or hand it to the share sheet.

export class GalleryPermissionError extends Error {
  constructor() {
    super('Photo access was not granted.');
    this.name = 'GalleryPermissionError';
  }
}

export class MediaNotReadyError extends Error {
  constructor() {
    super('This file is not ready yet.');
    this.name = 'MediaNotReadyError';
  }
}

const MIME_BY_EXTENSION: Record<string, string> = {
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
  mp4: 'video/mp4',
  mov: 'video/quicktime',
};

export function mimeTypeOf(media: MediaObject): string {
  const extension = media.filename.slice(media.filename.lastIndexOf('.') + 1).toLowerCase();
  return MIME_BY_EXTENSION[extension] ?? (media.mediaType === 'video' ? 'video/mp4' : 'image/jpeg');
}

function cacheFileFor(media: MediaObject): File {
  const safeName = media.filename.replace(/[^A-Za-z0-9._-]/g, '_');
  const hasExtension = /\.[A-Za-z0-9]+$/.test(safeName);
  return new File(Paths.cache, hasExtension ? safeName : `${safeName}.${media.mediaType === 'video' ? 'mp4' : 'jpg'}`);
}

// Always fetches again: a partial file may be left behind by an interrupted download.
export async function downloadToCache(media: MediaObject): Promise<File> {
  if (media.url === null) throw new MediaNotReadyError();
  const file = cacheFileFor(media);
  try {
    return await File.downloadFileAsync(media.url, file, { idempotent: true });
  } catch (error) {
    try {
      if (file.exists) file.delete();
    } catch {
      // Nothing left to clean up.
    }
    throw error;
  }
}

// Write-only access is enough to add files; the system asks the first time. Android 10 and newer let an app
// add its own files to the shared collections without any permission, so a "not granted" answer is not final there.
export async function ensureGalleryPermission(): Promise<void> {
  if ((await MediaLibrary.getPermissionsAsync(true)).granted) return;
  if ((await MediaLibrary.requestPermissionsAsync(true)).granted) return;
  if (Platform.OS === 'android' && typeof Platform.Version === 'number' && Platform.Version >= 29) return;
  throw new GalleryPermissionError();
}

export async function saveToGallery(media: MediaObject): Promise<void> {
  await ensureGalleryPermission();
  const file = await downloadToCache(media);
  await MediaLibrary.Asset.create(file.uri);
}

export async function shareMedia(media: MediaObject): Promise<void> {
  if (!(await Sharing.isAvailableAsync())) throw new Error('Sharing is not available on this device.');
  const file = await downloadToCache(media);
  await Sharing.shareAsync(file.uri, { mimeType: mimeTypeOf(media), dialogTitle: 'Share' });
}
