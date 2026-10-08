import { getSessionToken } from '@/lib/shopify';
import { archiveFileName, type ArchiveFile } from './archive';
import { sanitizeFilename } from './download-policy';
import { ZIP_MAX_FILES, ZipError, ZipWriter } from './zip';

export { isAllowedDownloadHost, sanitizeFilename } from './download-policy';

export interface DownloadItem {
  url: string;
  filename: string;
}

// 'saved': the browser got the file. 'opened': a soft failure, the file could not be fetched, so its URL was
// opened in a new tab for a manual save. 'failed': nothing worked (or the tab was blocked).
export type DownloadOutcome = 'saved' | 'opened' | 'failed';

export const DOWNLOAD_PROXY_PATH = '/api/download';

// Long enough for the browser to start reading the object URL, short enough not to hold the blob for long.
const REVOKE_DELAY_MS = 30_000;

async function toBlob(response: Response): Promise<Blob> {
  if (!response.ok) throw new Error(`Download failed with status ${response.status}`);
  return response.blob();
}

// Works when the CDN answers with CORS headers.
async function fetchDirect(url: string, signal?: AbortSignal): Promise<Blob> {
  return toBlob(
    await fetch(url, { credentials: 'omit', referrerPolicy: 'no-referrer', ...(signal === undefined ? {} : { signal }) }),
  );
}

// Same file through our server, which adds no CORS requirement (and which only serves Shopify CDN files). Needs the
// App Bridge session token.
async function fetchViaProxy(url: string, filename: string, signal?: AbortSignal): Promise<Blob> {
  const token = await getSessionToken();
  const query = new URLSearchParams({ url, name: filename });
  return toBlob(
    await fetch(`${DOWNLOAD_PROXY_PATH}?${query.toString()}`, {
      headers: { Authorization: `Bearer ${token}` },
      ...(signal === undefined ? {} : { signal }),
    }),
  );
}

// Direct first, then through the proxy. Throws when neither works.
async function fetchBlob(url: string, filename: string, signal?: AbortSignal): Promise<Blob> {
  try {
    return await fetchDirect(url, signal);
  } catch {
    signal?.throwIfAborted();
    return fetchViaProxy(url, filename, signal);
  }
}

function saveBlob(blob: Blob, filename: string): void {
  const objectUrl = URL.createObjectURL(blob);
  try {
    const anchor = document.createElement('a');
    anchor.href = objectUrl;
    anchor.download = filename;
    anchor.rel = 'noopener';
    anchor.style.display = 'none';
    document.body.append(anchor);
    anchor.click();
    anchor.remove();
  } catch (error) {
    URL.revokeObjectURL(objectUrl);
    throw error;
  }
  setTimeout(() => URL.revokeObjectURL(objectUrl), REVOKE_DELAY_MS);
}

function openTab(url: string): boolean {
  const tab = window.open(url, '_blank');
  if (tab === null) return false;
  try {
    tab.opener = null;
  } catch {
    // A cross-origin tab may refuse; the opener link is already one way.
  }
  return true;
}

function openInNewTab(url: string): boolean {
  return /^https?:\/\//i.test(url) && openTab(url);
}

export interface DownloadFileOptions {
  // Open the URL in a new tab when it cannot be fetched. On by default; off for bulk downloads.
  openOnFailure?: boolean;
}

// Never throws. Tries a direct fetch, then the proxy, then (optionally) a new tab.
export async function downloadFile(
  url: string,
  filename: string,
  { openOnFailure = true }: DownloadFileOptions = {},
): Promise<DownloadOutcome> {
  const name = sanitizeFilename(filename);
  const strategies = [() => fetchDirect(url), () => fetchViaProxy(url, name)];
  for (const load of strategies) {
    try {
      saveBlob(await load(), name);
      return 'saved';
    } catch {
      // Try the next strategy.
    }
  }
  if (!openOnFailure) return 'failed';
  return openInNewTab(url) ? 'opened' : 'failed';
}

export type ZipOutcome =
  // The browser got the zip.
  | 'saved'
  // The zip could not be saved by the browser, so it was opened in a new tab.
  | 'opened'
  // Nothing was saved: no file could be fetched, or the browser refused the zip.
  | 'failed'
  // The caller aborted (the page was left).
  | 'cancelled'
  // Too many files or bytes for one zip (see ZIP_MAX_FILES and ZIP_MAX_BYTES).
  | 'too_large';

export interface ZipDownloadResult {
  outcome: ZipOutcome;
  // Files asked for.
  total: number;
  // Files in the zip.
  added: number;
  // Paths of the files that could not be fetched and are not in the zip, in order.
  skipped: string[];
}

export interface ZipDownloadOptions {
  signal?: AbortSignal;
  // onProgress(0, total) runs first, then onProgress(n, total) after each file (fetched or skipped).
  onProgress?: (done: number, total: number) => void;
}

// The anchor route of the single download; a browser that refuses it (a sandboxed admin iframe can) gets the blob
// opened in a new tab instead.
function saveZip(blob: Blob, filename: string): 'saved' | 'opened' | 'failed' {
  try {
    saveBlob(blob, filename);
    return 'saved';
  } catch {
    // Open it in a tab below.
  }
  try {
    const objectUrl = URL.createObjectURL(blob);
    setTimeout(() => URL.revokeObjectURL(objectUrl), REVOKE_DELAY_MS);
    return openTab(objectUrl) ? 'opened' : 'failed';
  } catch {
    return 'failed';
  }
}

// Fetches the files one at a time (direct, then through the proxy), stores them uncompressed in one zip kept as
// Blob parts, and saves it under `archiveName`. A file that cannot be fetched is skipped and listed in the result;
// only when no file could be fetched is nothing saved. Never throws.
export async function downloadZip(
  files: readonly ArchiveFile[],
  archiveName: string,
  { signal, onProgress }: ZipDownloadOptions = {},
): Promise<ZipDownloadResult> {
  const total = files.length;
  const result = (outcome: ZipOutcome, added: number, skipped: string[]): ZipDownloadResult => ({
    outcome,
    total,
    added,
    skipped,
  });
  if (total === 0) return result('failed', 0, []);
  if (total > ZIP_MAX_FILES) return result('too_large', 0, []);

  const aborted = (): boolean => signal?.aborted === true;
  const zip = new ZipWriter();
  const skipped: string[] = [];
  onProgress?.(0, total);
  for (const [index, file] of files.entries()) {
    if (aborted()) return result('cancelled', zip.fileCount, skipped);
    try {
      await zip.add(file.path, await fetchBlob(file.url, archiveFileName(file.path), signal));
    } catch (error) {
      if (aborted()) return result('cancelled', zip.fileCount, skipped);
      if (error instanceof ZipError && (error.reason === 'too_large' || error.reason === 'too_many_files')) {
        return result('too_large', zip.fileCount, skipped);
      }
      skipped.push(file.path);
    }
    onProgress?.(index + 1, total);
  }
  if (aborted()) return result('cancelled', zip.fileCount, skipped);
  if (zip.fileCount === 0) return result('failed', 0, skipped);
  return result(saveZip(zip.finish(), archiveName), zip.fileCount, skipped);
}
