// Pure rules of the download feature, shared by the browser helper (lib/download.ts) and the proxy route.

export const MAX_DOWNLOAD_BYTES = 500 * 1024 * 1024;

const CDN_HOST = 'cdn.shopify.com';
const CDN_SUFFIX = '.shopifycdn.com';

// The parsed URL when it is safe to fetch on a merchant's behalf, otherwise null. Only https URLs of the Shopify
// CDN pass: no credentials in the URL, no port other than the default one, no IP literal. Fetch the returned
// `href`, never the raw input, so the check and the request see the same host.
export function parseDownloadUrl(raw: string): URL | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:') return null;
  if (url.username !== '' || url.password !== '' || url.port !== '') return null;
  const host = url.hostname;
  const isCdn = host === CDN_HOST || (host.endsWith(CDN_SUFFIX) && host.length > CDN_SUFFIX.length);
  return isCdn ? url : null;
}

export function isAllowedDownloadHost(raw: string): boolean {
  return parseDownloadUrl(raw) !== null;
}

const MAX_FILENAME_LENGTH = 120;

// A file name that is safe in an anchor `download` attribute and a Content-Disposition header: no path, no
// leading dot, only letters, digits, dot, dash and underscore.
export function sanitizeFilename(name: string, fallback = 'download'): string {
  const base = name.split(/[/\\]/).pop() ?? '';
  let clean = base.replace(/[^A-Za-z0-9._-]/g, '_').replace(/^\.+/, '');
  if (clean.length > MAX_FILENAME_LENGTH) {
    const extension = /\.[A-Za-z0-9]{1,8}$/.exec(clean)?.[0] ?? '';
    clean = clean.slice(0, MAX_FILENAME_LENGTH - extension.length) + extension;
  }
  return clean === '' ? fallback : clean;
}

// Errors the stream once more than maxBytes have passed, for bodies that arrive without a content-length.
export function limitBytes(maxBytes: number): TransformStream<Uint8Array, Uint8Array> {
  let seen = 0;
  return new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      seen += chunk.byteLength;
      if (seen > maxBytes) controller.error(new Error('Download is too large'));
      else controller.enqueue(chunk);
    },
  });
}
