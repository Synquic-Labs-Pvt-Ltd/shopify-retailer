import {
  ApiError,
  ERROR_CODES,
  ERROR_HTTP_STATUS,
  batchListQuerySchema,
  createBatchRequestSchema,
  idParamsSchema,
  mediaListQuerySchema,
  productGidParamsSchema,
  productListQuerySchema,
  uploadsRequestSchema,
  type Api,
  type ErrorCode,
  type ErrorEnvelope,
} from '@rs/shared';
import type { ZodType } from 'zod';
import { hasBearerToken } from '@/lib/bearer';

// The mock HTTP surface of the web app (NEXT_PUBLIC_MOCK=1): maps (method, path, query, body) to the in-memory
// Api, with the same status codes and error envelope as the real backend. No Next imports, so it is unit-testable.

export const API_PREFIX = '/api/v1/';

export type MockApi = Omit<Api, 'auth'>;
type Method = 'GET' | 'POST' | 'DELETE';

export interface MockRequest {
  method: string;
  // Pathname of the request URL, still percent-encoded, for example /api/v1/products/gid%3A%2F%2Fshopify%2FProduct%2F1.
  pathname: string;
  query: URLSearchParams;
  body: unknown;
  authorization: string | null;
}

export interface MockResponse {
  status: number;
  // Undefined for 204.
  body?: unknown;
}

interface RouteContext {
  api: MockApi;
  params: Readonly<Record<string, string>>;
  query: URLSearchParams;
  body: unknown;
}

interface Route {
  method: Method;
  // Segments after /api/v1. `:name` captures one segment, `*name` the rest of the path.
  pattern: string;
  handle(context: RouteContext): Promise<MockResponse>;
}

class RequestError extends Error {
  readonly code: ErrorCode;
  readonly details: unknown;

  constructor(code: ErrorCode, message: string, details?: unknown) {
    super(message);
    this.code = code;
    this.details = details;
  }
}

const ok = (body: unknown, status = 200): MockResponse => ({ status, body });

function parse<T>(schema: ZodType<T>, input: unknown): T {
  const result = schema.safeParse(input);
  if (result.success) return result.data;
  const issues = result.error.issues.map((issue) => ({
    path: issue.path.map(String).join('.'),
    message: issue.message,
    code: issue.code,
  }));
  throw new RequestError('validation_failed', 'Request validation failed', { issues });
}

const queryOf = (query: URLSearchParams): Record<string, string> => Object.fromEntries(query.entries());

export const MOCK_ROUTES: readonly Route[] = [
  { method: 'GET', pattern: 'me', handle: async ({ api }) => ok(await api.me()) },
  {
    method: 'GET',
    pattern: 'products',
    handle: async ({ api, query }) => ok(await api.products.list(parse(productListQuerySchema, queryOf(query)))),
  },
  {
    method: 'GET',
    pattern: 'products/*gid',
    handle: async ({ api, params }) => ok(await api.products.get(parse(productGidParamsSchema, params).gid)),
  },
  {
    method: 'POST',
    pattern: 'media/uploads',
    handle: async ({ api, body }) => ok(await api.media.createUploads(parse(uploadsRequestSchema, body))),
  },
  {
    method: 'POST',
    pattern: 'media/:id/complete',
    handle: async ({ api, params }) => ok(await api.media.complete(parse(idParamsSchema, params).id)),
  },
  {
    method: 'GET',
    pattern: 'media',
    handle: async ({ api, query }) =>
      ok(await api.media.list(parse(mediaListQuerySchema, { ids: query.get('ids') ?? '' }).ids)),
  },
  {
    method: 'DELETE',
    pattern: 'media/:id',
    handle: async ({ api, params }) => {
      await api.media.remove(parse(idParamsSchema, params).id);
      return { status: 204 };
    },
  },
  {
    method: 'POST',
    pattern: 'batches',
    handle: async ({ api, body }) => ok(await api.batches.create(parse(createBatchRequestSchema, body)), 201),
  },
  {
    method: 'GET',
    pattern: 'batches',
    handle: async ({ api, query }) => ok(await api.batches.list(parse(batchListQuerySchema, queryOf(query)))),
  },
  {
    method: 'GET',
    pattern: 'batches/:id',
    handle: async ({ api, params }) => ok(await api.batches.get(parse(idParamsSchema, params).id)),
  },
  {
    method: 'POST',
    pattern: 'batches/:id/cancel',
    handle: async ({ api, params }) => ok(await api.batches.cancel(parse(idParamsSchema, params).id)),
  },
  {
    method: 'POST',
    pattern: 'batches/:id/retry-failed',
    handle: async ({ api, params }) => ok(await api.batches.retryFailed(parse(idParamsSchema, params).id)),
  },
];

export function errorResponse(code: ErrorCode, message: string, details?: unknown): MockResponse {
  const body: ErrorEnvelope = { error: { code, message, ...(details === undefined ? {} : { details }) } };
  return { status: ERROR_HTTP_STATUS[code], body };
}

function decodeSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    throw new RequestError('validation_failed', 'Malformed path');
  }
}

function matchRoute(route: Route, segments: readonly string[]): Record<string, string> | null {
  const pattern = route.pattern.split('/');
  const params: Record<string, string> = {};
  for (const [index, part] of pattern.entries()) {
    if (part.startsWith('*')) {
      const rest = segments.slice(index);
      if (rest.length === 0) return null;
      params[part.slice(1)] = rest.join('/');
      return params;
    }
    const segment = segments[index];
    if (segment === undefined) return null;
    if (part.startsWith(':')) params[part.slice(1)] = segment;
    else if (part !== segment) return null;
  }
  return segments.length === pattern.length ? params : null;
}

function toErrorResponse(error: unknown): MockResponse {
  if (error instanceof RequestError) return errorResponse(error.code, error.message, error.details);
  if (error instanceof ApiError) {
    const code = ERROR_CODES.find((candidate) => candidate === error.code);
    return code === undefined
      ? errorResponse('internal', 'Internal error')
      : errorResponse(code, error.message, error.details);
  }
  return errorResponse('internal', 'Internal error');
}

export async function handleMockRequest(api: MockApi, request: MockRequest): Promise<MockResponse> {
  try {
    // Any non-empty bearer value passes: the mock does not verify the App Bridge session token.
    if (!hasBearerToken(request.authorization)) {
      return errorResponse('unauthorized', 'Missing or invalid session token');
    }
    if (!request.pathname.startsWith(API_PREFIX)) return errorResponse('not_found', 'Not found');
    const segments = request.pathname.slice(API_PREFIX.length).split('/');
    if (segments.at(-1) === '') segments.pop();
    const decoded = segments.map(decodeSegment);
    for (const route of MOCK_ROUTES) {
      if (route.method !== request.method) continue;
      const params = matchRoute(route, decoded);
      if (params !== null) return await route.handle({ api, params, query: request.query, body: request.body });
    }
    return errorResponse('not_found', 'Not found');
  } catch (error) {
    return toErrorResponse(error);
  }
}
