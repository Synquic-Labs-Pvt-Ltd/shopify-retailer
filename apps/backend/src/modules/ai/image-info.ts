// The pixel size of a generated image, read from its header. The image models return PNG or JPEG; anything else (or a
// damaged header) reads as unknown rather than guessed. Only the header is read: no pixel is decoded.

export interface ImageSize {
  width: number;
  height: number;
}

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
// Start-of-frame markers carry the size; C4 (huffman tables), C8 and CC are not frames.
const SOF_MARKERS = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf]);

const u16 = (bytes: Uint8Array, at: number): number => ((bytes[at] ?? 0) << 8) | (bytes[at + 1] ?? 0);
const u32 = (bytes: Uint8Array, at: number): number => (u16(bytes, at) * 0x10000) + u16(bytes, at + 2);

function pngSize(bytes: Uint8Array): ImageSize | null {
  if (bytes.length < 24 || !PNG_SIGNATURE.every((value, index) => bytes[index] === value)) return null;
  const width = u32(bytes, 16);
  const height = u32(bytes, 20);
  return width > 0 && height > 0 ? { width, height } : null;
}

function jpegSize(bytes: Uint8Array): ImageSize | null {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return null;
  let at = 2;
  while (at + 4 <= bytes.length) {
    if (bytes[at] !== 0xff) {
      at += 1;
      continue;
    }
    const marker = bytes[at + 1] ?? 0;
    if (marker === 0xff) {
      at += 1; // fill byte
      continue;
    }
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd9)) {
      at += 2; // markers without a length
      continue;
    }
    if (SOF_MARKERS.has(marker)) {
      const height = u16(bytes, at + 5);
      const width = u16(bytes, at + 7);
      return width > 0 && height > 0 ? { width, height } : null;
    }
    at += 2 + u16(bytes, at + 2);
  }
  return null;
}

export type ImageFormat = 'png' | 'jpeg';

// The real format of the bytes, from their first bytes. The label a model puts on an image is not trusted for this:
// a JPEG has been seen under a PNG label.
export function imageFormatOf(bytes: Uint8Array): ImageFormat | null {
  if (bytes.length >= 8 && PNG_SIGNATURE.every((value, index) => bytes[index] === value)) return 'png';
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'jpeg';
  return null;
}

export const MIME_OF_FORMAT: Record<ImageFormat, string> = { png: 'image/png', jpeg: 'image/jpeg' };

export function imageSizeOf(bytes: Uint8Array): ImageSize | null {
  return pngSize(bytes) ?? jpegSize(bytes);
}
