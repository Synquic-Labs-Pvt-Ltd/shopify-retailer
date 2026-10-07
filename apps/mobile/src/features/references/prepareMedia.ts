import { File } from 'expo-file-system';
import { ImageManipulator, SaveFormat, type ImageResult } from 'expo-image-manipulator';
import { isHeic, replaceExtension, type PickedAsset } from './pickedAsset';

// SPEC 9, before upload: HEIC and HEIF become JPEG, and every image is downscaled to a 2048 px long edge
// at quality 0.9. Videos are uploaded as they are.
export const MAX_LONG_EDGE = 2048;
export const JPEG_QUALITY = 0.9;

export interface PreparedFile {
  uri: string;
  fileName: string;
  mimeType: string;
  // Bytes on disk. 0 when the file cannot be read.
  fileSize: number;
}

export function fileSizeOf(uri: string, fallback: number | null = null): number {
  try {
    const size = new File(uri).size;
    if (size > 0) return size;
  } catch {
    // Not a readable file URI: use what the picker reported.
  }
  return fallback ?? 0;
}

type Resize = { width: number } | { height: number };

function resizeFor(width: number, height: number): Resize {
  return width >= height ? { width: MAX_LONG_EDGE } : { height: MAX_LONG_EDGE };
}

async function renderJpeg(uri: string, resize: Resize | null): Promise<ImageResult> {
  const context = ImageManipulator.manipulate(uri);
  try {
    if (resize !== null) context.resize(resize);
    const image = await context.renderAsync();
    try {
      return await image.saveAsync({ format: SaveFormat.JPEG, compress: JPEG_QUALITY });
    } finally {
      image.release();
    }
  } finally {
    context.release();
  }
}

export async function prepareVideo(asset: PickedAsset): Promise<PreparedFile> {
  return {
    uri: asset.uri,
    fileName: asset.fileName,
    mimeType: asset.mimeType ?? 'video/mp4',
    fileSize: fileSizeOf(asset.uri, asset.fileSize),
  };
}

export async function prepareImage(asset: PickedAsset): Promise<PreparedFile> {
  const knownSize = asset.width > 0 && asset.height > 0;
  const tooLarge = Math.max(asset.width, asset.height) > MAX_LONG_EDGE;
  if (!isHeic(asset.mimeType) && knownSize && !tooLarge) {
    return {
      uri: asset.uri,
      fileName: asset.fileName,
      mimeType: asset.mimeType ?? 'image/jpeg',
      fileSize: fileSizeOf(asset.uri, asset.fileSize),
    };
  }

  let result = await renderJpeg(asset.uri, knownSize && tooLarge ? resizeFor(asset.width, asset.height) : null);
  // The picker's size may ignore EXIF rotation: make sure the long edge really is within the limit.
  if (Math.max(result.width, result.height) > MAX_LONG_EDGE) {
    result = await renderJpeg(result.uri, resizeFor(result.width, result.height));
  }
  return {
    uri: result.uri,
    fileName: replaceExtension(asset.fileName, 'jpg'),
    mimeType: 'image/jpeg',
    fileSize: fileSizeOf(result.uri),
  };
}
