// Byte downloads of Shopify CDN and media urls for the handlers (SPEC 10.2, 10.3, 10.4).

export const MAX_DOWNLOAD_BYTES = 20 * 1024 * 1024;

export class DownloadError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'DownloadError';
  }
}

export interface DownloadedMedia {
  bytes: Uint8Array;
  mimeType: string;
}

const EXTENSION_MIME: Record<string, string> = {
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
  mp4: 'video/mp4',
  mov: 'video/quicktime',
};

function mimeFrom(contentType: string | null, url: URL, fallback: string): string {
  const declared = contentType?.split(';')[0]?.trim().toLowerCase() ?? '';
  if (declared.startsWith('image/') || declared.startsWith('video/')) return declared;
  const extension = /\.([a-z0-9]{2,4})$/i.exec(url.pathname)?.[1]?.toLowerCase();
  return (extension === undefined ? undefined : EXTENSION_MIME[extension]) ?? fallback;
}

async function readCapped(response: Response, maxBytes: number): Promise<Uint8Array> {
  if (response.body === null) {
    const whole = new Uint8Array(await response.arrayBuffer());
    if (whole.byteLength > maxBytes) throw new DownloadError(`File is larger than ${maxBytes} bytes`);
    return whole;
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw new DownloadError(`File is larger than ${maxBytes} bytes`);
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

// https only, with the caller's AbortSignal and a size cap. Every failure is a DownloadError, which the
// handlers turn into a transient retry.
export async function downloadBytes(
  fetchImpl: typeof fetch,
  url: string,
  signal: AbortSignal,
  fallbackMimeType: string,
  maxBytes: number = MAX_DOWNLOAD_BYTES,
): Promise<DownloadedMedia> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch (err) {
    throw new DownloadError('Download url is not valid', { cause: err });
  }
  if (parsed.protocol !== 'https:') throw new DownloadError('Only https downloads are allowed');

  try {
    const response = await fetchImpl(parsed, { signal });
    if (!response.ok) {
      await response.body?.cancel();
      throw new DownloadError(`Download failed with HTTP ${response.status}`);
    }
    const declared = Number(response.headers.get('content-length'));
    if (Number.isFinite(declared) && declared > maxBytes) {
      await response.body?.cancel();
      throw new DownloadError(`File is larger than ${maxBytes} bytes`);
    }
    const bytes = await readCapped(response, maxBytes);
    return { bytes, mimeType: mimeFrom(response.headers.get('content-type'), parsed, fallbackMimeType) };
  } catch (err) {
    if (err instanceof DownloadError) throw err;
    throw new DownloadError(`Download failed: ${err instanceof Error ? err.message : String(err)}`, { cause: err });
  }
}
