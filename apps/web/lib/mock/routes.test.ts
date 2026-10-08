import { createMockApi, resetMockApi } from '@rs/mock-api';
import {
  batchDetailSchema,
  batchListResponseSchema,
  batchSummarySchema,
  errorEnvelopeSchema,
  mediaCompleteResponseSchema,
  mediaListResponseSchema,
  meResponseSchema,
  productDetailSchema,
  productListResponseSchema,
  referencesRequiredDetailsSchema,
  uploadsResponseSchema,
} from '@rs/shared';
import type { ZodType } from 'zod';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { hasBearerToken } from '@/lib/bearer';
import { MOCK_ROUTES, handleMockRequest, type MockApi, type MockRequest, type MockResponse } from './routes';

const GID = 'gid://shopify/Product/8000000000';
const MEDIA_ID = 'a'.repeat(24);
const KEY = '5b1d1f0e-0d6e-4c4e-9a53-3f6c8d9b2a11';

let api: MockApi;
beforeEach(() => {
  resetMockApi();
  api = createMockApi({ latencyMs: 0 });
});
afterEach(() => resetMockApi());

function call(
  method: string,
  path: string,
  options: { body?: unknown; authorization?: string | null; target?: MockApi } = {},
): Promise<MockResponse> {
  const url = new URL(`http://localhost${path}`);
  const request: MockRequest = {
    method,
    pathname: url.pathname,
    query: url.searchParams,
    body: options.body,
    authorization: options.authorization === undefined ? 'Bearer mock-session-token' : options.authorization,
  };
  return handleMockRequest(options.target ?? api, request);
}

async function expectError(promise: Promise<MockResponse>, status: number, code: string): Promise<MockResponse> {
  const response = await promise;
  expect(response.status).toBe(status);
  const envelope = errorEnvelopeSchema.parse(response.body);
  expect(envelope.error.code).toBe(code);
  return response;
}

async function createBatchId(): Promise<string> {
  const response = await call('POST', '/api/v1/batches', {
    body: { idempotencyKey: KEY, products: [{ productGid: GID }], commonReferenceMediaIds: [MEDIA_ID] },
  });
  return batchSummarySchema.parse(response.body).id;
}

async function createMediaId(): Promise<string> {
  const response = await call('POST', '/api/v1/media/uploads', {
    body: { files: [{ clientId: 'c1', filename: 'a.jpg', mimeType: 'image/jpeg', fileSize: 10, scope: 'common' }] },
  });
  return uploadsResponseSchema.parse(response.body).targets[0]?.mediaId ?? '';
}

interface RouteCase {
  route: string;
  status: number;
  schema: ZodType | null;
  run(): Promise<MockResponse>;
}

const CASES: RouteCase[] = [
  { route: 'GET me', status: 200, schema: meResponseSchema, run: () => call('GET', '/api/v1/me') },
  {
    route: 'GET products',
    status: 200,
    schema: productListResponseSchema,
    run: () => call('GET', '/api/v1/products?q=lamp&limit=20'),
  },
  {
    route: 'GET products/*gid',
    status: 200,
    schema: productDetailSchema,
    run: () => call('GET', `/api/v1/products/${encodeURIComponent(GID)}`),
  },
  {
    route: 'POST media/uploads',
    status: 200,
    schema: uploadsResponseSchema,
    run: () =>
      call('POST', '/api/v1/media/uploads', {
        body: { files: [{ clientId: 'c1', filename: 'a.jpg', mimeType: 'image/jpeg', fileSize: 10, scope: 'common' }] },
      }),
  },
  {
    route: 'POST media/:id/complete',
    status: 200,
    schema: mediaCompleteResponseSchema,
    run: async () => call('POST', `/api/v1/media/${await createMediaId()}/complete`),
  },
  {
    route: 'GET media',
    status: 200,
    schema: mediaListResponseSchema,
    run: async () => call('GET', `/api/v1/media?ids=${await createMediaId()}`),
  },
  {
    route: 'DELETE media/:id',
    status: 204,
    schema: null,
    run: async () => call('DELETE', `/api/v1/media/${await createMediaId()}`),
  },
  {
    route: 'POST batches',
    status: 201,
    schema: batchSummarySchema,
    run: () =>
      call('POST', '/api/v1/batches', {
        body: { idempotencyKey: KEY, products: [{ productGid: GID }], commonReferenceMediaIds: [MEDIA_ID] },
      }),
  },
  { route: 'GET batches', status: 200, schema: batchListResponseSchema, run: () => call('GET', '/api/v1/batches?limit=2') },
  {
    route: 'GET batches/:id',
    status: 200,
    schema: batchDetailSchema,
    run: async () => call('GET', `/api/v1/batches/${await createBatchId()}`),
  },
  {
    route: 'POST batches/:id/cancel',
    status: 200,
    schema: batchSummarySchema,
    run: async () => call('POST', `/api/v1/batches/${await createBatchId()}/cancel`),
  },
  {
    route: 'POST batches/:id/retry-failed',
    status: 200,
    schema: batchSummarySchema,
    run: async () => call('POST', `/api/v1/batches/${await createBatchId()}/retry-failed`),
  },
];

describe('route table', () => {
  it.each(CASES)('$route answers $status with a body that validates', async ({ status, schema, run }) => {
    const response = await run();
    expect(response.status).toBe(status);
    if (schema === null) expect(response.body).toBeUndefined();
    else expect(schema.safeParse(response.body).success).toBe(true);
  });

  it('is covered case by case', () => {
    const routes = MOCK_ROUTES.map((route) => `${route.method} ${route.pattern}`).sort();
    expect(CASES.map((testCase) => testCase.route).sort()).toEqual(routes);
  });
});

describe('request details', () => {
  it('reads products by raw or encoded gid and pages with a cursor', async () => {
    const encoded = await call('GET', `/api/v1/products/${encodeURIComponent(GID)}`);
    const raw = await call('GET', `/api/v1/products/${GID}`);
    expect(raw.body).toEqual(encoded.body);

    const first = productListResponseSchema.parse((await call('GET', '/api/v1/products?limit=20')).body);
    expect(first.items).toHaveLength(20);
    const second = await call('GET', `/api/v1/products?limit=20&cursor=${first.pageInfo.endCursor}`);
    expect(productListResponseSchema.parse(second.body).items[0]?.id).not.toBe(first.items[0]?.id);
  });

  it('defaults the page size to 25 like the backend', async () => {
    const page = productListResponseSchema.parse((await call('GET', '/api/v1/products')).body);
    expect(page.items).toHaveLength(25);
  });

  it('accepts a trailing slash', async () => {
    expect((await call('GET', '/api/v1/me/')).status).toBe(200);
  });

  it('removes a deleted reference from the list', async () => {
    const id = await createMediaId();
    await call('DELETE', `/api/v1/media/${id}`);
    const list = mediaListResponseSchema.parse((await call('GET', `/api/v1/media?ids=${id}`)).body);
    expect(list.items).toEqual([]);
  });
});

describe('authorization', () => {
  it.each([null, '', 'Bearer', 'Bearer ', 'Basic abc', 'abc'])('answers 401 for %j', async (authorization) => {
    await expectError(call('GET', '/api/v1/me', { authorization }), 401, 'unauthorized');
  });

  it('checks the token before the route, so unknown paths are 401 too', async () => {
    await expectError(call('GET', '/api/v1/nope', { authorization: null }), 401, 'unauthorized');
  });

  it('accepts any non-empty bearer value', () => {
    expect(hasBearerToken('Bearer x')).toBe(true);
    expect(hasBearerToken('bearer eyJ.abc.def')).toBe(true);
    expect(hasBearerToken('Bearer a b')).toBe(false);
  });
});

describe('errors use the shared envelope and status table', () => {
  it('404s for unknown routes and wrong methods', async () => {
    await expectError(call('GET', '/api/v1/nope'), 404, 'not_found');
    await expectError(call('GET', '/api/v1/'), 404, 'not_found');
    await expectError(call('DELETE', '/api/v1/me'), 404, 'not_found');
    await expectError(call('POST', '/api/v1/products'), 404, 'not_found');
    await expectError(call('GET', '/api/v1/batches/x/y/z'), 404, 'not_found');
    await expectError(call('GET', '/other/me'), 404, 'not_found');
  });

  it('400s with the zod issues for an invalid body, query, id or path', async () => {
    const body = await expectError(call('POST', '/api/v1/batches', { body: { products: [] } }), 400, 'validation_failed');
    const { error } = errorEnvelopeSchema.parse(body.body);
    expect(error.details).toMatchObject({ issues: expect.arrayContaining([expect.objectContaining({ path: 'idempotencyKey' })]) });

    await expectError(call('POST', '/api/v1/media/uploads', { body: undefined }), 400, 'validation_failed');
    await expectError(call('GET', '/api/v1/media'), 400, 'validation_failed');
    await expectError(call('GET', '/api/v1/products?limit=500'), 400, 'validation_failed');
    await expectError(call('GET', '/api/v1/batches/not-an-id'), 400, 'validation_failed');
    await expectError(call('GET', '/api/v1/products/not-a-gid'), 400, 'validation_failed');
    await expectError(call('GET', '/api/v1/products/%E0%A4%A'), 400, 'validation_failed');
  });

  it('passes mock ApiErrors through with their status', async () => {
    await expectError(call('GET', `/api/v1/batches/${MEDIA_ID}`), 404, 'not_found');
    await expectError(call('POST', `/api/v1/media/${MEDIA_ID}/complete`), 404, 'not_found');
    await expectError(call('GET', '/api/v1/products/gid:%2F%2Fshopify%2FProduct%2F1'), 404, 'not_found');
    await expectError(call('GET', '/api/v1/products?q=error'), 500, 'internal');
  });

  it('422s references_required with the product gids in details', async () => {
    const response = await expectError(
      call('POST', '/api/v1/batches', { body: { idempotencyKey: KEY, products: [{ productGid: GID }] } }),
      422,
      'references_required',
    );
    const { error } = errorEnvelopeSchema.parse(response.body);
    expect(referencesRequiredDetailsSchema.parse(error.details)).toEqual({ productGids: [GID] });
  });

  it('429s shop_limit on the fourth active batch', async () => {
    for (let index = 0; index < 3; index += 1) {
      const body = { idempotencyKey: `5b1d1f0e-0d6e-4c4e-9a53-3f6c8d9b2a1${index}`, products: [{ productGid: GID }], commonReferenceMediaIds: [MEDIA_ID] };
      expect((await call('POST', '/api/v1/batches', { body })).status).toBe(201);
    }
    await expectError(
      call('POST', '/api/v1/batches', {
        body: { idempotencyKey: '5b1d1f0e-0d6e-4c4e-9a53-3f6c8d9b2a99', products: [{ productGid: GID }], commonReferenceMediaIds: [MEDIA_ID] },
      }),
      429,
      'shop_limit',
    );
  });

  it('hides unexpected failures behind a generic 500', async () => {
    const broken: MockApi = {
      ...api,
      me: () => Promise.reject(new Error('secret detail')),
    };
    const response = await expectError(call('GET', '/api/v1/me', { target: broken }), 500, 'internal');
    expect(JSON.stringify(response.body)).not.toContain('secret detail');
  });
});
