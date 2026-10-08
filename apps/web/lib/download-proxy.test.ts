import { errorEnvelopeSchema } from '@rs/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { proxyDownload } from './download-proxy';

const CDN_URL = 'https://cdn.shopify.com/s/files/1/0001/photo.jpg';
const BACKEND = 'http://backend.test';

const fetchMock = vi.fn<typeof fetch>();

beforeEach(() => {
  vi.stubGlobal('fetch', fetchMock);
  vi.stubEnv('BACKEND_URL', `${BACKEND}/`);
  vi.stubEnv('NEXT_PUBLIC_MOCK', '');
  fetchMock.mockImplementation((input) => {
    const url = String(input);
    if (url === `${BACKEND}/api/v1/me`) return Promise.resolve(new Response('{}', { status: 200 }));
    return Promise.resolve(
      new Response(new Uint8Array([1, 2, 3, 4]), { status: 200, headers: { 'content-type': 'image/jpeg', 'content-length': '4' } }),
    );
  });
});

afterEach(() => {
  fetchMock.mockReset();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

function request(options: { url?: string; name?: string; authorization?: string | null } = {}): Request {
  const params = new URLSearchParams({ url: options.url ?? CDN_URL });
  if (options.name !== undefined) params.set('name', options.name);
  const headers = new Headers();
  const authorization = options.authorization === undefined ? 'Bearer session-token' : options.authorization;
  if (authorization !== null) headers.set('authorization', authorization);
  return new Request(`http://localhost/api/download?${params.toString()}`, { headers });
}

async function expectFailure(response: Response, status: number, code: string): Promise<void> {
  expect(response.status).toBe(status);
  expect(errorEnvelopeSchema.parse(await response.json()).error.code).toBe(code);
}

const upstreamCalls = (): unknown[][] => fetchMock.mock.calls.filter(([input]) => !String(input).startsWith(BACKEND));

describe('authentication', () => {
  it('rejects a request without a bearer token before any network call', async () => {
    await expectFailure(await proxyDownload(request({ authorization: null })), 401, 'unauthorized');
    await expectFailure(await proxyDownload(request({ authorization: 'Basic abc' })), 401, 'unauthorized');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('checks the token against GET /api/v1/me of the backend with the same header', async () => {
    await proxyDownload(request());
    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(url).toBe(`${BACKEND}/api/v1/me`);
    expect(new Headers(init?.headers).get('authorization')).toBe('Bearer session-token');
  });

  it('answers 401 when the backend rejects the token and fetches nothing', async () => {
    fetchMock.mockResolvedValueOnce(new Response('{}', { status: 401 }));
    await expectFailure(await proxyDownload(request()), 401, 'unauthorized');
    expect(upstreamCalls()).toHaveLength(0);
  });

  it('answers 502 when the backend cannot be reached or fails', async () => {
    fetchMock.mockRejectedValueOnce(new TypeError('connect ECONNREFUSED'));
    await expectFailure(await proxyDownload(request()), 502, 'internal');
    fetchMock.mockResolvedValueOnce(new Response('{}', { status: 500 }));
    await expectFailure(await proxyDownload(request()), 502, 'internal');
    expect(upstreamCalls()).toHaveLength(0);
  });

  it('skips the backend check in mock mode but still needs a bearer value', async () => {
    vi.stubEnv('NEXT_PUBLIC_MOCK', '1');
    expect((await proxyDownload(request())).status).toBe(200);
    expect(fetchMock.mock.calls.every(([input]) => !String(input).startsWith(BACKEND))).toBe(true);
    await expectFailure(await proxyDownload(request({ authorization: null })), 401, 'unauthorized');
  });
});

describe('url policy', () => {
  it.each([
    ['http://cdn.shopify.com/photo.jpg'],
    ['https://cdn.shopify.com@evil.test/photo.jpg'],
    ['https://evil.test/photo.jpg'],
    ['https://127.0.0.1/photo.jpg'],
    [''],
  ])('answers 400 for %j without fetching it', async (url) => {
    await expectFailure(await proxyDownload(request({ url })), 400, 'validation_failed');
    expect(upstreamCalls()).toHaveLength(0);
  });

  it('answers 400 when the url parameter is missing', async () => {
    const response = await proxyDownload(
      new Request('http://localhost/api/download', { headers: { authorization: 'Bearer t' } }),
    );
    await expectFailure(response, 400, 'validation_failed');
  });
});

describe('upstream request', () => {
  it('never follows redirects and never sends the session token to the CDN', async () => {
    await proxyDownload(request());
    const [url, init] = upstreamCalls()[0] ?? [];
    expect(url).toBe(CDN_URL);
    const options = init as RequestInit;
    expect(options.redirect).toBe('manual');
    expect(new Headers(options.headers).has('authorization')).toBe(false);
  });

  it.each([301, 302, 303, 307, 308])('treats a %i answer as an error', async (status) => {
    fetchMock.mockImplementation((input) =>
      Promise.resolve(
        String(input).startsWith(BACKEND)
          ? new Response('{}', { status: 200 })
          : new Response(null, { status, headers: { location: 'https://evil.test/' } }),
      ),
    );
    await expectFailure(await proxyDownload(request()), 502, 'internal');
  });

  it('maps an upstream 404 to not_found and other failures to 502', async () => {
    const answer = (status: number) =>
      fetchMock.mockImplementation((input) =>
        Promise.resolve(new Response(String(input).startsWith(BACKEND) ? '{}' : 'x', { status: String(input).startsWith(BACKEND) ? 200 : status })),
      );
    answer(404);
    await expectFailure(await proxyDownload(request()), 404, 'not_found');
    answer(500);
    await expectFailure(await proxyDownload(request()), 502, 'internal');
    answer(403);
    await expectFailure(await proxyDownload(request()), 502, 'internal');
  });

  it('answers 502 when the CDN cannot be reached', async () => {
    fetchMock.mockImplementation((input) =>
      String(input).startsWith(BACKEND) ? Promise.resolve(new Response('{}')) : Promise.reject(new TypeError('fetch failed')),
    );
    await expectFailure(await proxyDownload(request()), 502, 'internal');
  });
});

describe('response', () => {
  it('streams the body as an attachment with the upstream content type', async () => {
    const response = await proxyDownload(request({ name: 'rs-lamp-img1.jpg' }));
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('image/jpeg');
    expect(response.headers.get('content-disposition')).toBe("attachment; filename*=UTF-8''rs-lamp-img1.jpg");
    expect(response.headers.get('content-length')).toBe('4');
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
    expect(response.headers.get('cache-control')).toBe('private, no-store');
    expect([...new Uint8Array(await response.arrayBuffer())]).toEqual([1, 2, 3, 4]);
  });

  it('sanitises the file name and falls back when it is missing', async () => {
    const unsafe = await proxyDownload(request({ name: '../../evil name?.jpg' }));
    expect(unsafe.headers.get('content-disposition')).toBe("attachment; filename*=UTF-8''evil_name_.jpg");
    const missing = await proxyDownload(request());
    expect(missing.headers.get('content-disposition')).toBe("attachment; filename*=UTF-8''download");
  });

  it('falls back to a binary content type', async () => {
    fetchMock.mockImplementation((input) =>
      Promise.resolve(String(input).startsWith(BACKEND) ? new Response('{}') : new Response(new Uint8Array([9]))),
    );
    const response = await proxyDownload(request());
    expect(response.headers.get('content-type')).toBe('application/octet-stream');
  });

  it('rejects a declared size above 500 MB without streaming it', async () => {
    fetchMock.mockImplementation((input) =>
      Promise.resolve(
        String(input).startsWith(BACKEND)
          ? new Response('{}')
          : new Response(new Uint8Array([1]), { headers: { 'content-length': String(500 * 1024 * 1024 + 1) } }),
      ),
    );
    await expectFailure(await proxyDownload(request()), 413, 'validation_failed');
  });

  it('accepts exactly 500 MB', async () => {
    fetchMock.mockImplementation((input) =>
      Promise.resolve(
        String(input).startsWith(BACKEND)
          ? new Response('{}')
          : new Response(new Uint8Array([1]), { headers: { 'content-length': String(500 * 1024 * 1024) } }),
      ),
    );
    expect((await proxyDownload(request())).status).toBe(200);
  });
});
