import type { ZodType } from 'zod';
import {
  authSessionResponseSchema,
  batchDetailSchema,
  batchListResponseSchema,
  batchSummarySchema,
  errorEnvelopeSchema,
  mediaCompleteResponseSchema,
  mediaListResponseSchema,
  meResponseSchema,
  productDetailSchema,
  productListResponseSchema,
  uploadsResponseSchema,
} from '@rs/shared';
import { useAuthStore } from '../state/auth';
import { createMockApi } from './mock';
import { ApiError, type Api, type TokenRefresher } from './types';

export { ApiError } from './types';
export type { Api, TokenRefresher } from './types';

export const API_BASE_URL: string = (process.env.EXPO_PUBLIC_API_BASE_URL ?? 'http://localhost:3000').replace(/\/+$/, '');
export const API_MOCK: boolean = process.env.EXPO_PUBLIC_API_MOCK === 'true';

type HttpMethod = 'GET' | 'POST' | 'DELETE';
type QueryValue = string | number | undefined;

interface RequestOptions {
  method: HttpMethod;
  path: string;
  query?: Record<string, QueryValue>;
  body?: unknown;
  // Bearer header and 401 refresh. Off for auth exchange and refresh.
  auth?: boolean;
}

let tokenRefresher: TokenRefresher = { refresh: () => Promise.resolve(false) };

export function setTokenRefresher(refresher: TokenRefresher): void {
  tokenRefresher = refresher;
}

// URLSearchParams is only partly implemented in React Native, so the query string is built by hand.
function buildUrl(path: string, query: Record<string, QueryValue> | undefined): string {
  const parts: string[] = [];
  for (const [key, value] of Object.entries(query ?? {})) {
    if (value !== undefined) parts.push(`${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`);
  }
  return `${API_BASE_URL}${path}${parts.length > 0 ? `?${parts.join('&')}` : ''}`;
}

function currentAccessToken(): string | undefined {
  return useAuthStore.getState().session?.accessToken;
}

async function fetchOnce(options: RequestOptions, accessToken: string | undefined): Promise<Response> {
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (options.body !== undefined) headers['Content-Type'] = 'application/json';
  if (options.auth !== false && accessToken !== undefined) headers.Authorization = `Bearer ${accessToken}`;
  try {
    return await fetch(buildUrl(options.path, options.query), {
      method: options.method,
      headers,
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
    });
  } catch (err) {
    throw new ApiError(0, 'network_error', 'Cannot reach the server', err);
  }
}

// On 401 the request is retried exactly once with a new access token. Concurrent 401s share one refresh
// (the TokenRefresher is single-flight); a request that was sent with an older token than the current one
// skips the refresh because another request already renewed the session.
async function execute(options: RequestOptions): Promise<Response> {
  const sentToken = options.auth === false ? undefined : currentAccessToken();
  const response = await fetchOnce(options, sentToken);
  if (response.status !== 401 || options.auth === false) return response;

  const latest = currentAccessToken();
  const renewed = latest !== undefined && latest !== sentToken ? true : await tokenRefresher.refresh();
  return renewed ? fetchOnce(options, currentAccessToken()) : response;
}

async function readJson(response: Response): Promise<unknown> {
  try {
    return (await response.json()) as unknown;
  } catch {
    return undefined;
  }
}

async function toApiError(response: Response): Promise<ApiError> {
  const parsed = errorEnvelopeSchema.safeParse(await readJson(response));
  if (!parsed.success) {
    return new ApiError(response.status, 'internal', `Request failed with status ${response.status}`);
  }
  const { code, message, details } = parsed.data.error;
  // The shop needs a new offline token: send the user back to login.
  if (code === 'shop_reauth_required') useAuthStore.getState().clearSession();
  return new ApiError(response.status, code, message, details);
}

async function request<T>(schema: ZodType<T>, options: RequestOptions): Promise<T> {
  const response = await execute(options);
  if (!response.ok) throw await toApiError(response);
  const parsed = schema.safeParse(await readJson(response));
  if (!parsed.success) {
    throw new ApiError(response.status, 'invalid_response', 'Unexpected server response', parsed.error.issues);
  }
  return parsed.data;
}

async function requestVoid(options: RequestOptions): Promise<void> {
  const response = await execute(options);
  if (!response.ok) throw await toApiError(response);
}

export function createHttpApi(): Api {
  return {
    auth: {
      exchange: (body) =>
        request(authSessionResponseSchema, { method: 'POST', path: '/api/v1/auth/exchange', body, auth: false }),
      refresh: (body) =>
        request(authSessionResponseSchema, { method: 'POST', path: '/api/v1/auth/refresh', body, auth: false }),
      logout: (body) => requestVoid({ method: 'POST', path: '/api/v1/auth/logout', body }),
    },
    me: () => request(meResponseSchema, { method: 'GET', path: '/api/v1/me' }),
    products: {
      list: (params) =>
        request(productListResponseSchema, {
          method: 'GET',
          path: '/api/v1/products',
          query: { q: params?.q, cursor: params?.cursor, limit: params?.limit },
        }),
      get: (gid) =>
        request(productDetailSchema, { method: 'GET', path: `/api/v1/products/${encodeURIComponent(gid)}` }),
    },
    media: {
      createUploads: (body) =>
        request(uploadsResponseSchema, { method: 'POST', path: '/api/v1/media/uploads', body }),
      complete: (id) =>
        request(mediaCompleteResponseSchema, { method: 'POST', path: `/api/v1/media/${id}/complete` }),
      list: (ids) =>
        request(mediaListResponseSchema, { method: 'GET', path: '/api/v1/media', query: { ids: ids.join(',') } }),
      remove: (id) => requestVoid({ method: 'DELETE', path: `/api/v1/media/${id}` }),
    },
    batches: {
      create: (body) => request(batchSummarySchema, { method: 'POST', path: '/api/v1/batches', body }),
      list: (params) =>
        request(batchListResponseSchema, {
          method: 'GET',
          path: '/api/v1/batches',
          query: { cursor: params?.cursor, limit: params?.limit },
        }),
      get: (id) => request(batchDetailSchema, { method: 'GET', path: `/api/v1/batches/${id}` }),
      cancel: (id) => request(batchSummarySchema, { method: 'POST', path: `/api/v1/batches/${id}/cancel` }),
      retryFailed: (id) =>
        request(batchSummarySchema, { method: 'POST', path: `/api/v1/batches/${id}/retry-failed` }),
    },
  };
}

// The app talks to this. EXPO_PUBLIC_API_MOCK=true swaps in the in-memory fixtures.
export const api: Api = API_MOCK ? createMockApi() : createHttpApi();
