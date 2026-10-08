import type { DecodedImage, ImageDecoder } from './prepareImage';

// The browser implementation of ImageDecoder: createImageBitmap decodes (and applies EXIF rotation), a canvas
// scales and encodes. Only touches the DOM inside its methods, so importing it on the server is safe.

const THUMBNAIL_QUALITY = 0.7;

function drawn(bitmap: ImageBitmap, width: number, height: number): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext('2d');
  if (context === null) throw new Error('Canvas is not available.');
  // JPEG has no alpha channel: transparent pixels would turn black without a background.
  context.fillStyle = '#ffffff';
  context.fillRect(0, 0, width, height);
  context.imageSmoothingQuality = 'high';
  context.drawImage(bitmap, 0, 0, width, height);
  return canvas;
}

function encode(canvas: HTMLCanvasElement, quality: number): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => (blob === null ? reject(new Error('The image could not be encoded.')) : resolve(blob)),
      'image/jpeg',
      quality,
    );
  });
}

function wrap(bitmap: ImageBitmap): DecodedImage {
  return {
    width: bitmap.width,
    height: bitmap.height,
    toJpeg: (width, height, quality) => encode(drawn(bitmap, width, height), quality),
    thumbnail: async (maxEdge) => {
      try {
        const ratio = Math.min(1, maxEdge / Math.max(bitmap.width, bitmap.height));
        const width = Math.max(1, Math.round(bitmap.width * ratio));
        const height = Math.max(1, Math.round(bitmap.height * ratio));
        return drawn(bitmap, width, height).toDataURL('image/jpeg', THUMBNAIL_QUALITY);
      } catch {
        return null;
      }
    },
    close: () => bitmap.close(),
  };
}

export const browserImageDecoder: ImageDecoder = {
  decode: async (file) => wrap(await createImageBitmap(file, { imageOrientation: 'from-image' })),
};
