import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';

const getSessionToken = vi.hoisted(() => vi.fn<() => Promise<string>>());
vi.mock('@/lib/shopify', () => ({ getSessionToken }));

import type { ArchiveFile } from './archive';
import { downloadFile, downloadZip } from './download';
import { ZIP_MAX_BYTES, ZIP_MAX_FILES, crc32 } from './zip';
import { parseZip } from './zipTestkit';

interface FakeAnchor {
  href: string;
  download: string;
  rel: string;
  style: { display: string };
  click: ReturnType<typeof vi.fn>;
  remove: ReturnType<typeof vi.fn>;
}

const URL_A = 'https://cdn.shopify.com/s/files/a.jpg';
const URL_B = 'https://cdn.shopify.com/s/files/b.jpg';
const URL_C = 'https://cdn.shopify.com/s/files/c.mp4';
const CORS_ERROR = new TypeError('Failed to fetch');

const fetchMock = vi.fn<typeof fetch>();
const openMock = vi.fn<(url: string, target: string) => { opener: unknown } | null>();
let anchors: FakeAnchor[];
let revoke: MockInstance<typeof URL.revokeObjectURL>;

const isProxy = (input: unknown): boolean => String(input).startsWith('/api/download?');
const blobResponse = (): Response => new Response(new Blob(['file']), { status: 200 });

beforeEach(() => {
  vi.useFakeTimers();
  anchors = [];
  vi.stubGlobal('fetch', fetchMock);
  vi.stubGlobal('document', {
    createElement: () => {
      const anchor: FakeAnchor = { href: '', download: '', rel: '', style: { display: '' }, click: vi.fn(), remove: vi.fn() };
      anchors.push(anchor);
      return anchor;
    },
    body: { append: vi.fn() },
  });
  vi.stubGlobal('window', { open: openMock });
  revoke = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined);
  getSessionToken.mockResolvedValue('session-token');
  fetchMock.mockImplementation(() => Promise.resolve(blobResponse()));
  openMock.mockReturnValue({ opener: 'parent' });
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  fetchMock.mockReset();
  openMock.mockReset();
  getSessionToken.mockReset();
});

describe('downloadFile', () => {
  it('saves a CORS friendly file straight from the CDN through an anchor and revokes the object URL later', async () => {
    expect(await downloadFile(URL_A, 'rs-lamp-img1.jpg')).toBe('saved');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith(URL_A, { credentials: 'omit', referrerPolicy: 'no-referrer' });
    expect(getSessionToken).not.toHaveBeenCalled();

    const [anchor] = anchors;
    expect(anchor?.download).toBe('rs-lamp-img1.jpg');
    expect(anchor?.href).toMatch(/^blob:/);
    expect(anchor?.click).toHaveBeenCalledTimes(1);
    expect(anchor?.remove).toHaveBeenCalledTimes(1);

    expect(revoke).not.toHaveBeenCalled();
    vi.advanceTimersByTime(30_000);
    expect(revoke).toHaveBeenCalledWith(anchor?.href);
  });

  it('sanitises the file name', async () => {
    await downloadFile(URL_A, '../my photo (1).jpg');
    expect(anchors[0]?.download).toBe('my_photo__1_.jpg');
  });

  it('falls back to the proxy with the session token when the CDN blocks the fetch', async () => {
    fetchMock.mockImplementation((input) => (isProxy(input) ? Promise.resolve(blobResponse()) : Promise.reject(CORS_ERROR)));
    expect(await downloadFile(URL_A, 'a b.jpg')).toBe('saved');

    const proxyCall = fetchMock.mock.calls.find(([input]) => isProxy(input));
    const [input, init] = proxyCall ?? [];
    const query = new URL(String(input), 'http://localhost').searchParams;
    expect(query.get('url')).toBe(URL_A);
    expect(query.get('name')).toBe('a_b.jpg');
    expect(new Headers(init?.headers).get('authorization')).toBe('Bearer session-token');
    expect(anchors[0]?.download).toBe('a_b.jpg');
    expect(openMock).not.toHaveBeenCalled();
  });

  it('also uses the proxy when the CDN answers with an error status', async () => {
    fetchMock.mockImplementation((input) =>
      Promise.resolve(isProxy(input) ? blobResponse() : new Response('no', { status: 403 })),
    );
    expect(await downloadFile(URL_A, 'a.jpg')).toBe('saved');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('opens the URL in a new tab as a soft failure when both fetches fail', async () => {
    fetchMock.mockRejectedValue(CORS_ERROR);
    const tab = { opener: 'parent' };
    openMock.mockReturnValue(tab);
    expect(await downloadFile(URL_A, 'a.jpg')).toBe('opened');
    expect(openMock).toHaveBeenCalledWith(URL_A, '_blank');
    expect(tab.opener).toBeNull();
    expect(anchors).toHaveLength(0);
  });

  it('opens the tab when the proxy answers 401 or the session token is unavailable', async () => {
    fetchMock.mockImplementation((input) =>
      Promise.resolve(isProxy(input) ? new Response('{}', { status: 401 }) : new Response('no', { status: 403 })),
    );
    expect(await downloadFile(URL_A, 'a.jpg')).toBe('opened');

    getSessionToken.mockRejectedValue(new Error('App Bridge is not loaded'));
    fetchMock.mockRejectedValue(CORS_ERROR);
    expect(await downloadFile(URL_A, 'a.jpg')).toBe('opened');
  });

  it('reports failed when the tab is blocked or the URL is not http(s)', async () => {
    fetchMock.mockRejectedValue(CORS_ERROR);
    openMock.mockReturnValue(null);
    expect(await downloadFile(URL_A, 'a.jpg')).toBe('failed');
    openMock.mockClear();
    expect(await downloadFile('javascript:alert(1)', 'a.jpg')).toBe('failed');
    expect(openMock).not.toHaveBeenCalled();
  });

  it('does not open a tab when asked not to', async () => {
    fetchMock.mockRejectedValue(CORS_ERROR);
    expect(await downloadFile(URL_A, 'a.jpg', { openOnFailure: false })).toBe('failed');
    expect(openMock).not.toHaveBeenCalled();
  });
});

// A blob that claims to be as large as the whole zip may be, without the memory.
class HugeBlob extends Blob {
  override get size(): number {
    return ZIP_MAX_BYTES;
  }
}

describe('downloadZip', () => {
  const FILES: ArchiveFile[] = [
    { url: URL_A, path: 'Lamp/lamp-1.jpg' },
    { url: URL_B, path: 'Lamp/lamp-2.jpg' },
    { url: URL_C, path: 'Tote/tote-1.mp4' },
  ];
  const bodies: Record<string, string> = { [URL_A]: 'AAAA', [URL_B]: 'BBBBBB', [URL_C]: 'CC' };
  let saved: Blob[];

  const body = (input: unknown): string => bodies[String(input)] ?? 'unknown';

  beforeEach(() => {
    saved = [];
    const create = URL.createObjectURL.bind(URL);
    vi.spyOn(URL, 'createObjectURL').mockImplementation((object) => {
      saved.push(object as Blob);
      return create(object);
    });
    fetchMock.mockImplementation((input) => Promise.resolve(new Response(body(input), { status: 200 })));
  });

  it('saves one zip with a folder per product, through the anchor of the single download', async () => {
    const progress: [number, number][] = [];
    const result = await downloadZip(FILES, 'retailer-studio-65f1c0.zip', {
      onProgress: (done, total) => progress.push([done, total]),
    });
    expect(result).toEqual({ outcome: 'saved', total: 3, added: 3, skipped: [] });
    expect(progress).toEqual([[0, 3], [1, 3], [2, 3], [3, 3]]);

    expect(anchors).toHaveLength(1);
    expect(anchors[0]?.download).toBe('retailer-studio-65f1c0.zip');
    expect(anchors[0]?.href).toMatch(/^blob:/);
    expect(anchors[0]?.click).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(30_000);
    expect(revoke).toHaveBeenCalledWith(anchors[0]?.href);

    const zip = await parseZip(saved[0] as Blob);
    expect(zip.entries.map((entry) => entry.name)).toEqual(['Lamp/lamp-1.jpg', 'Lamp/lamp-2.jpg', 'Tote/tote-1.mp4']);
    expect(zip.entries.map((entry) => new TextDecoder().decode(entry.data))).toEqual(['AAAA', 'BBBBBB', 'CC']);
    expect(zip.entries.map((entry) => entry.crc)).toEqual(['AAAA', 'BBBBBB', 'CC'].map((text) => crc32(new TextEncoder().encode(text))));
  });

  it('fetches one file at a time, directly first and through the proxy when the CDN blocks it', async () => {
    let running = 0;
    let overlapped = false;
    fetchMock.mockImplementation(async (input) => {
      running += 1;
      overlapped ||= running > 1;
      await Promise.resolve();
      running -= 1;
      if (!isProxy(input) && String(input) === URL_B) throw CORS_ERROR;
      return new Response(isProxy(input) ? 'PROXIED' : body(input), { status: 200 });
    });
    const result = await downloadZip(FILES, 'x.zip');
    expect(result.outcome).toBe('saved');
    expect(overlapped).toBe(false);

    const proxyCalls = fetchMock.mock.calls.filter(([input]) => isProxy(input));
    expect(proxyCalls).toHaveLength(1);
    const [input, init] = proxyCalls[0] ?? [];
    const query = new URL(String(input), 'http://localhost').searchParams;
    expect(query.get('url')).toBe(URL_B);
    expect(query.get('name')).toBe('lamp-2.jpg');
    expect(new Headers(init?.headers).get('authorization')).toBe('Bearer session-token');

    const zip = await parseZip(saved[0] as Blob);
    expect(zip.entries.map((entry) => new TextDecoder().decode(entry.data))).toEqual(['AAAA', 'PROXIED', 'CC']);
  });

  it('skips a file that cannot be fetched, lists it, and still saves the others', async () => {
    fetchMock.mockImplementation((input) =>
      String(input).includes('b.jpg') ? Promise.reject(CORS_ERROR) : Promise.resolve(new Response(body(input))),
    );
    const progress: number[] = [];
    const result = await downloadZip(FILES, 'x.zip', { onProgress: (done) => progress.push(done) });
    expect(result).toEqual({ outcome: 'saved', total: 3, added: 2, skipped: ['Lamp/lamp-2.jpg'] });
    expect(progress).toEqual([0, 1, 2, 3]);
    expect(openMock).not.toHaveBeenCalled();
    const zip = await parseZip(saved[0] as Blob);
    expect(zip.entries.map((entry) => entry.name)).toEqual(['Lamp/lamp-1.jpg', 'Tote/tote-1.mp4']);
  });

  it('also skips a file the CDN and the proxy answer with an error status', async () => {
    fetchMock.mockImplementation((input) =>
      Promise.resolve(String(input) === URL_A || String(input).includes(encodeURIComponent(URL_A)) ? new Response('no', { status: 404 }) : new Response(body(input))),
    );
    const result = await downloadZip(FILES, 'x.zip');
    expect(result).toMatchObject({ outcome: 'saved', added: 2, skipped: ['Lamp/lamp-1.jpg'] });
  });

  it('saves nothing, and opens no tab, when every file fails', async () => {
    fetchMock.mockRejectedValue(CORS_ERROR);
    const result = await downloadZip(FILES, 'x.zip');
    expect(result).toEqual({
      outcome: 'failed',
      total: 3,
      added: 0,
      skipped: ['Lamp/lamp-1.jpg', 'Lamp/lamp-2.jpg', 'Tote/tote-1.mp4'],
    });
    expect(anchors).toHaveLength(0);
    expect(openMock).not.toHaveBeenCalled();
  });

  it('has nothing to do for no files', async () => {
    const onProgress = vi.fn();
    expect(await downloadZip([], 'x.zip', { onProgress })).toEqual({ outcome: 'failed', total: 0, added: 0, skipped: [] });
    expect(onProgress).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('stops without saving when the caller aborts, for example because the page was left', async () => {
    const controller = new AbortController();
    const result = await downloadZip(FILES, 'x.zip', {
      signal: controller.signal,
      onProgress: (done) => {
        if (done === 1) controller.abort();
      },
    });
    expect(result).toMatchObject({ outcome: 'cancelled', added: 1 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(anchors).toHaveLength(0);
  });

  it('passes the abort signal to the requests and does not start when already aborted', async () => {
    const controller = new AbortController();
    await downloadZip(FILES.slice(0, 1), 'x.zip', { signal: controller.signal });
    expect(fetchMock.mock.calls[0]?.[1]?.signal).toBe(controller.signal);

    controller.abort();
    fetchMock.mockClear();
    expect((await downloadZip(FILES, 'x.zip', { signal: controller.signal })).outcome).toBe('cancelled');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('reports a request cut short by the abort as cancelled, not as a skipped file', async () => {
    const controller = new AbortController();
    fetchMock.mockImplementation(() => {
      controller.abort();
      return Promise.reject(new DOMException('aborted', 'AbortError'));
    });
    const result = await downloadZip(FILES, 'x.zip', { signal: controller.signal });
    expect(result).toEqual({ outcome: 'cancelled', total: 3, added: 0, skipped: [] });
  });

  it('refuses more files than a zip can list before fetching any', async () => {
    const many = Array.from({ length: ZIP_MAX_FILES + 1 }, (_, index) => ({ url: URL_A, path: `f/${index}` }));
    expect(await downloadZip(many, 'x.zip')).toMatchObject({ outcome: 'too_large', added: 0 });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('stops with too_large when the files add up to more than a zip can hold', async () => {
    fetchMock.mockImplementation((input) =>
      Promise.resolve(String(input) === URL_B ? ({ ok: true, status: 200, blob: () => Promise.resolve(new HugeBlob()) } as Response) : new Response('x')),
    );
    const result = await downloadZip(FILES, 'x.zip');
    expect(result).toEqual({ outcome: 'too_large', total: 3, added: 1, skipped: [] });
    expect(anchors).toHaveLength(0);
  });

  it('opens the zip in a new tab when the browser throws on the download', async () => {
    const tab = { opener: 'parent' };
    openMock.mockReturnValue(tab);
    vi.stubGlobal('document', {
      createElement: () => ({ style: {}, click: () => { throw new Error('downloads are blocked'); }, remove: vi.fn() }),
      body: { append: vi.fn() },
    });
    const result = await downloadZip(FILES, 'x.zip');
    expect(result.outcome).toBe('opened');
    expect(openMock).toHaveBeenCalledTimes(1);
    expect(openMock.mock.calls[0]?.[0]).toMatch(/^blob:/);
    expect(openMock.mock.calls[0]?.[1]).toBe('_blank');
    expect(tab.opener).toBeNull();
  });

  it('fails when neither the download nor the new tab works', async () => {
    openMock.mockReturnValue(null);
    vi.stubGlobal('document', {
      createElement: () => ({ style: {}, click: () => { throw new Error('downloads are blocked'); }, remove: vi.fn() }),
      body: { append: vi.fn() },
    });
    expect((await downloadZip(FILES, 'x.zip')).outcome).toBe('failed');
  });
});
