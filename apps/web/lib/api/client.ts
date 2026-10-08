import { ApiError, errorEnvelopeSchema } from '@rs/shared';
import type { ZodType } from 'zod';
import { getSessionToken } from '@/lib/shopify';
import {
  GET_RETRY,
  NO_RETRY,
  parseRetryAfter,
  retryDelayMs,
  shouldRetryRequest,
  type RetryRule,
} from './retry';

type HttpMethod = 'GET' | 'POST' | 'DELETE';
type QueryValue = string | number | undefined;

// One attempt waits at most this long for the whole answer (headers and body).
export const REQUEST_TIMEOUT_MS = 30_000;

export interface RequestOptions<T> {
  method: HttpMethod;
  // Path under the same origin, for example /api/v1/products. The Next app forwards /api/v1/* to the backend
  // (or serves the in-memory mock when NEXT_PUBLIC_MOCK=1).
  path: string;
  query?: Record<string, QueryValue>;
  body?: unknown;
  // Validates the response body. Omit for endpoints that return no body (204).
  schema?: ZodType<T>;
  // Aborting it rejects with an AbortError (never with a timeout) and cancels any pending retry.
  signal?: AbortSignal;
  // Per attempt. Defaults to REQUEST_TIMEOUT_MS.
  timeoutMs?: number;
  // Defaults to GET_RETRY for a GET and NO_RETRY for everything else.
  retry?: RetryRule;
}

// What apiRequest reaches the outside world through; tests replace it.
export interface ClientDeps {
  fetch: (input: string, init: RequestInit) => Promise<Response>;
  getToken: () => Promise<string>;
  // Rejects with an AbortError when the signal aborts first.
  sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
  random: () => number;
  now: () => number;
}

function abortError(): DOMException {
  return new DOMException('The request was aborted', 'AbortError');
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError';
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted === true) {
      reject(abortError());
      return;
    }
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(abortError());
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

const defaultDeps: ClientDeps = {
  // An arrow, not `fetch` itself: the browser throws "Illegal invocation" when fetch is called on another object.
  fetch: (input, init) => fetch(input, init),
  getToken: getSessionToken,
  sleep,
  random: Math.random,
  now: Date.now,
};

function buildUrl(path: string, query: Record<string, QueryValue> | undefined): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query ?? {})) {
    if (value !== undefined) params.set(key, String(value));
  }
  const qs = params.toString();
  return qs.length > 0 ? `${path}?${qs}` : path;
}

// Reads the whole body, so a connection lost or a timeout while it streams surfaces as a transport error.
// Text that is not JSON (an HTML error page of a proxy) gives undefined.
async function readJson(response: Response): Promise<unknown> {
  const text = await response.text();
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

const GATEWAY_STATUSES: readonly number[] = [502, 503, 504];

// Keeps whatever the server put in the details of the error and adds the wait it asked for.
function withRetryAfter(details: unknown, retryAfterSec: number | null): unknown {
  if (retryAfterSec === null) return details;
  if (details === undefined) return { retryAfterSec };
  if (typeof details === 'object' && details !== null && !Array.isArray(details)) return { ...details, retryAfterSec };
  return details;
}

// The ApiError for a non-2xx answer:
//  - 502, 503, 504 and any 5xx without the error envelope (a proxy or platform page): service_unavailable;
//  - 408: timeout; a 429 without the envelope: too_many_requests;
//  - otherwise the code of the envelope, or internal when there is none.
// The Retry-After of a 429 or 503 lands in details as { retryAfterSec }.
export function apiErrorFromResponse(
  status: number,
  payload: unknown,
  retryAfter: string | null = null,
  now: number = Date.now(),
): ApiError {
  const envelope = errorEnvelopeSchema.safeParse(payload);
  const retryAfterSec = status === 429 || status === 503 ? parseRetryAfter(retryAfter, now) : null;
  const details = envelope.success ? envelope.data.error.details : undefined;

  if (GATEWAY_STATUSES.includes(status) || (!envelope.success && status >= 500)) {
    const message = envelope.success ? envelope.data.error.message : `The service is unavailable (HTTP ${status})`;
    return new ApiError(status, 'service_unavailable', message, withRetryAfter(details, retryAfterSec));
  }
  if (!envelope.success) {
    if (status === 408) return new ApiError(status, 'timeout', 'The server took too long to answer');
    if (status === 429) {
      return new ApiError(status, 'too_many_requests', 'Too many requests', withRetryAfter(undefined, retryAfterSec));
    }
    return new ApiError(status, 'internal', `Request failed with status ${status}`);
  }
  const { code, message } = envelope.data.error;
  return new ApiError(status, code, message, withRetryAfter(details, retryAfterSec));
}

// What a failed fetch (or a body that broke off) means. A caller abort stays an AbortError, whatever the timer did.
function transportError(error: unknown, caller: AbortSignal | undefined, timeout: AbortSignal): unknown {
  if (caller?.aborted === true) return isAbortError(error) ? error : abortError();
  if (timeout.aborted) return new ApiError(0, 'timeout', 'The server took too long to answer', error);
  if (isAbortError(error)) return error;
  return new ApiError(0, 'network_error', 'Cannot reach the server', error);
}

// One attempt. Every attempt carries a fresh App Bridge session token (valid for one minute), so there is no
// refresh logic: a 401 means the app was not opened from the Shopify admin or the token was rejected.
async function attempt<T>(options: RequestOptions<T>, deps: ClientDeps): Promise<T> {
  let token: string;
  try {
    token = await deps.getToken();
  } catch (err) {
    throw new ApiError(401, 'unauthorized', 'Open the app from the Shopify admin.', err);
  }

  const headers: Record<string, string> = { Accept: 'application/json', Authorization: `Bearer ${token}` };
  if (options.body !== undefined) headers['Content-Type'] = 'application/json';

  const timeout = AbortSignal.timeout(options.timeoutMs ?? REQUEST_TIMEOUT_MS);
  const signal = options.signal === undefined ? timeout : AbortSignal.any([options.signal, timeout]);

  let response: Response;
  let payload: unknown;
  try {
    response = await deps.fetch(buildUrl(options.path, options.query), {
      method: options.method,
      headers,
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      signal,
    });
    payload = response.ok && options.schema === undefined ? undefined : await readJson(response);
  } catch (err) {
    throw transportError(err, options.signal, timeout);
  }

  if (!response.ok) {
    throw apiErrorFromResponse(response.status, payload, response.headers.get('Retry-After'), deps.now());
  }
  if (options.schema === undefined) return undefined as T;

  const parsed = options.schema.safeParse(payload);
  if (!parsed.success) {
    throw new ApiError(response.status, 'invalid_response', 'Unexpected server response', parsed.error.issues);
  }
  return parsed.data;
}

// A GET is retried (twice at most, see GET_RETRY) when the network failed, the server timed out, was unavailable
// or asked to slow down; nothing else is, and a POST or DELETE only when the caller passes a rule.
export async function apiRequest<T = void>(options: RequestOptions<T>, deps: ClientDeps = defaultDeps): Promise<T> {
  const rule = options.retry ?? (options.method === 'GET' ? GET_RETRY : NO_RETRY);
  for (let retriesDone = 0; ; retriesDone += 1) {
    try {
      return await attempt(options, deps);
    } catch (err) {
      if (!shouldRetryRequest(rule, err, retriesDone)) throw err;
      await deps.sleep(retryDelayMs(err, retriesDone, deps.random), options.signal);
    }
  }
}
