import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';

const getSessionToken = vi.hoisted(() => vi.fn<() => Promise<string>>());
vi.mock('@/lib/shopify', () => ({ getSessionToken }));

import { downloadAll, downloadFile } from './download';

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

describe('downloadAll', () => {
  it('downloads one file after the other and reports progress', async () => {
    const order: string[] = [];
    let running = 0;
    let overlapped = false;
    fetchMock.mockImplementation(async (input) => {
      running += 1;
      overlapped ||= running > 1;
      order.push(String(input));
      await Promise.resolve();
      running -= 1;
      return blobResponse();
    });
    const progress: [number, number][] = [];
    const summary = await downloadAll(
      [
        { url: URL_A, filename: 'a.jpg' },
        { url: URL_B, filename: 'b.jpg' },
        { url: URL_C, filename: 'c.mp4' },
      ],
      (done, total) => progress.push([done, total]),
    );
    expect(summary).toEqual({ saved: 3, failed: 0 });
    expect(order).toEqual([URL_A, URL_B, URL_C]);
    expect(overlapped).toBe(false);
    expect(progress).toEqual([[0, 3], [1, 3], [2, 3], [3, 3]]);
    expect(anchors.map((anchor) => anchor.download)).toEqual(['a.jpg', 'b.jpg', 'c.mp4']);
  });

  it('keeps going after a failure and counts it without opening tabs', async () => {
    fetchMock.mockImplementation((input) =>
      String(input).includes('b.jpg') ? Promise.reject(CORS_ERROR) : Promise.resolve(blobResponse()),
    );
    const progress: number[] = [];
    const summary = await downloadAll(
      [
        { url: URL_A, filename: 'a.jpg' },
        { url: URL_B, filename: 'b.jpg' },
        { url: URL_C, filename: 'c.mp4' },
      ],
      (done) => progress.push(done),
    );
    expect(summary).toEqual({ saved: 2, failed: 1 });
    expect(progress).toEqual([0, 1, 2, 3]);
    expect(openMock).not.toHaveBeenCalled();
  });

  it('returns an empty summary for no items', async () => {
    const onProgress = vi.fn();
    expect(await downloadAll([], onProgress)).toEqual({ saved: 0, failed: 0 });
    expect(onProgress).toHaveBeenCalledExactlyOnceWith(0, 0);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('works without a progress callback', async () => {
    expect(await downloadAll([{ url: URL_A, filename: 'a.jpg' }])).toEqual({ saved: 1, failed: 0 });
  });
});
