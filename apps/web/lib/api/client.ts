import { ApiError, errorEnvelopeSchema } from '@rs/shared';
import type { ZodType } from 'zod';
import { getSessionToken } from '@/lib/shopify';

type HttpMethod = 'GET' | 'POST' | 'DELETE';
type QueryValue = string | number | undefined;

export interface RequestOptions<T> {
  method: HttpMethod;
  // Path under the same origin, for example /api/v1/products. The Next app forwards /api/v1/* to the backend
  // (or serves the in-memory mock when NEXT_PUBLIC_MOCK=1).
  path: string;
  query?: Record<string, QueryValue>;
  body?: unknown;
  // Validates the response body. Omit for endpoints that return no body (204).
  schema?: ZodType<T>;
  signal?: AbortSignal;
}

function buildUrl(path: string, query: Record<string, QueryValue> | undefined): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query ?? {})) {
    if (value !== undefined) params.set(key, String(value));
  }
  const qs = params.toString();
  return qs.length > 0 ? `${path}?${qs}` : path;
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
  return new ApiError(response.status, code, message, details);
}

// Every call carries a fresh App Bridge session token (valid for one minute), so there is no refresh
// logic: a 401 means the app was not opened from the Shopify admin or the token was rejected.
export async function apiRequest<T = void>(options: RequestOptions<T>): Promise<T> {
  let token: string;
  try {
    token = await getSessionToken();
  } catch (err) {
    throw new ApiError(401, 'unauthorized', 'Open the app from the Shopify admin.', err);
  }

  const headers: Record<string, string> = { Accept: 'application/json', Authorization: `Bearer ${token}` };
  if (options.body !== undefined) headers['Content-Type'] = 'application/json';

  let response: Response;
  try {
    response = await fetch(buildUrl(options.path, options.query), {
      method: options.method,
      headers,
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      signal: options.signal,
    });
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') throw err;
    throw new ApiError(0, 'network_error', 'Cannot reach the server', err);
  }

  if (!response.ok) throw await toApiError(response);
  if (options.schema === undefined) return undefined as T;

  const parsed = options.schema.safeParse(await readJson(response));
  if (!parsed.success) {
    throw new ApiError(response.status, 'invalid_response', 'Unexpected server response', parsed.error.issues);
  }
  return parsed.data;
}
