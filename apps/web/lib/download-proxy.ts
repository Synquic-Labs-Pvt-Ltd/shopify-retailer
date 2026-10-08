import { ERROR_HTTP_STATUS, type ErrorCode, type ErrorEnvelope } from '@rs/shared';
import { hasBearerToken } from '@/lib/bearer';
import { MAX_DOWNLOAD_BYTES, limitBytes, parseDownloadUrl, sanitizeFilename } from '@/lib/download-policy';

// GET /api/download?url=&name=: streams a Shopify CDN file back as an attachment, for CDN responses without CORS
// headers. The caller must hold a valid App Bridge session token; the backend checks it. No URL is ever logged.

const BACKEND_CHECK_TIMEOUT_MS = 10_000;
const UPSTREAM_HEADERS_TIMEOUT_MS = 15_000;
const NO_STORE = 'private, no-store';

function fail(status: number, code: ErrorCode, message: string): Response {
  const body: ErrorEnvelope = { error: { code, message } };
  return Response.json(body, { status, headers: { 'Cache-Control': NO_STORE } });
}

type SessionCheck = 'ok' | 'unauthorized' | 'unavailable';

// Mock mode has no backend, so any bearer value is accepted there.
async function checkSession(authorization: string): Promise<SessionCheck> {
  if (process.env.NEXT_PUBLIC_MOCK === '1') return 'ok';
  const base = (process.env.BACKEND_URL ?? 'http://localhost:3000').replace(/\/+$/, '');
  try {
    const response = await fetch(`${base}/api/v1/me`, {
      headers: { Authorization: authorization, Accept: 'application/json' },
      cache: 'no-store',
      signal: AbortSignal.timeout(BACKEND_CHECK_TIMEOUT_MS),
    });
    if (response.ok) return 'ok';
    return response.status === 401 || response.status === 403 ? 'unauthorized' : 'unavailable';
  } catch {
    return 'unavailable';
  }
}

// Redirects are never followed, and the session token is never sent to the CDN.
async function fetchUpstream(url: URL, clientSignal: AbortSignal): Promise<Response | null> {
  const timeout = new AbortController();
  const timer = setTimeout(() => timeout.abort(), UPSTREAM_HEADERS_TIMEOUT_MS);
  try {
    return await fetch(url.href, {
      redirect: 'manual',
      headers: { Accept: '*/*' },
      cache: 'no-store',
      signal: AbortSignal.any([clientSignal, timeout.signal]),
    });
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

export async function proxyDownload(request: Request): Promise<Response> {
  const authorization = request.headers.get('authorization');
  if (authorization === null || !hasBearerToken(authorization)) {
    return fail(ERROR_HTTP_STATUS.unauthorized, 'unauthorized', 'Missing session token');
  }
  const session = await checkSession(authorization);
  if (session === 'unauthorized') return fail(ERROR_HTTP_STATUS.unauthorized, 'unauthorized', 'Invalid session token');
  if (session === 'unavailable') return fail(502, 'internal', 'Could not verify the session');

  const params = new URL(request.url).searchParams;
  const target = parseDownloadUrl(params.get('url') ?? '');
  if (target === null) return fail(ERROR_HTTP_STATUS.validation_failed, 'validation_failed', 'This file cannot be downloaded');
  const filename = sanitizeFilename(params.get('name') ?? '');

  const upstream = await fetchUpstream(target, request.signal);
  if (upstream === null) return fail(502, 'internal', 'The file could not be fetched');
  if (upstream.status === 404) return fail(ERROR_HTTP_STATUS.not_found, 'not_found', 'File not found');
  if (upstream.status !== 200 || upstream.body === null) {
    return fail(502, 'internal', 'The file could not be fetched');
  }

  const length = Number(upstream.headers.get('content-length') ?? '0');
  if (length > MAX_DOWNLOAD_BYTES) {
    void upstream.body.cancel();
    return fail(413, 'validation_failed', 'The file is too large to download');
  }

  const headers = new Headers({
    'Content-Type': upstream.headers.get('content-type') ?? 'application/octet-stream',
    'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`,
    'Cache-Control': NO_STORE,
    'X-Content-Type-Options': 'nosniff',
    'Content-Security-Policy': "default-src 'none'; sandbox",
  });
  // fetch() decodes compressed bodies, so the upstream length only fits an identity encoded one.
  if (length > 0 && !upstream.headers.has('content-encoding')) headers.set('Content-Length', String(length));
  return new Response(upstream.body.pipeThrough(limitBytes(MAX_DOWNLOAD_BYTES)), { status: 200, headers });
}
