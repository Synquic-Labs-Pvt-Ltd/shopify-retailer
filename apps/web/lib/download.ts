import { getSessionToken } from '@/lib/shopify';
import { sanitizeFilename } from './download-policy';

export { isAllowedDownloadHost, sanitizeFilename } from './download-policy';

export interface DownloadItem {
  url: string;
  filename: string;
}

export interface DownloadSummary {
  saved: number;
  failed: number;
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
async function fetchDirect(url: string): Promise<Blob> {
  return toBlob(await fetch(url, { credentials: 'omit', referrerPolicy: 'no-referrer' }));
}

// Same file through our server, which adds no CORS requirement. Needs the App Bridge session token.
async function fetchViaProxy(url: string, filename: string): Promise<Blob> {
  const token = await getSessionToken();
  const query = new URLSearchParams({ url, name: filename });
  return toBlob(await fetch(`${DOWNLOAD_PROXY_PATH}?${query.toString()}`, { headers: { Authorization: `Bearer ${token}` } }));
}

function saveBlob(blob: Blob, filename: string): void {
  const objectUrl = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = objectUrl;
  anchor.download = filename;
  anchor.rel = 'noopener';
  anchor.style.display = 'none';
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(objectUrl), REVOKE_DELAY_MS);
}

function openInNewTab(url: string): boolean {
  if (!/^https?:\/\//i.test(url)) return false;
  const tab = window.open(url, '_blank');
  if (tab === null) return false;
  try {
    tab.opener = null;
  } catch {
    // A cross-origin tab may refuse; the opener link is already one way.
  }
  return true;
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

// One file after the other, continuing after a failure. onProgress(0, total) runs first, then onProgress(n, total)
// after each file, so a label can read "Downloading n + 1 of total". Failed files are not opened in tabs.
export async function downloadAll(
  items: readonly DownloadItem[],
  onProgress?: (done: number, total: number) => void,
): Promise<DownloadSummary> {
  const total = items.length;
  let saved = 0;
  onProgress?.(0, total);
  for (const [index, item] of items.entries()) {
    const outcome = await downloadFile(item.url, item.filename, { openOnFailure: false });
    if (outcome === 'saved') saved += 1;
    onProgress?.(index + 1, total);
  }
  return { saved, failed: total - saved };
}
