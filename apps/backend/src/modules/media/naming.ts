import { randomBytes } from 'node:crypto';

const EXTENSIONS: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'video/mp4': 'mp4',
  'video/quicktime': 'mov',
};

export function extensionFor(mimeType: string): string {
  const known = EXTENSIONS[mimeType.toLowerCase()];
  if (known !== undefined) return known;
  const subtype = mimeType.split('/')[1] ?? 'bin';
  return subtype.replace(/[^a-z0-9]/gi, '').toLowerCase() || 'bin';
}

// SPEC 8.6: references are named rs-ref-{shortid}.{ext}. The extension must match the one Shopify
// derives from the staged upload, so the same name goes to stagedUploadsCreate and fileCreate.
export function referenceFilename(mimeType: string): string {
  return `rs-ref-${randomBytes(4).toString('hex')}.${extensionFor(mimeType)}`;
}
