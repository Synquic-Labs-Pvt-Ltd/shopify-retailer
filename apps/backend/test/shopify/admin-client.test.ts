import { describe, expect, it, vi } from 'vitest';
import { AppError } from '../../src/core/errors';
import { createLogger } from '../../src/core/logger';
import type { ShopRecord } from '../../src/modules/shops';
import { MAX_THROTTLE_RETRIES, createAdminClient, throttleWaitMs } from '../../src/modules/shopify/admin-client';
import type { ShopifyQueryCost } from '../../src/modules/shopify';

const SHOP_ID = 'a'.repeat(24);
const QUERY = '{ products(first: 1) { nodes { id } } }';

const shopRecord: ShopRecord = {
  id: SHOP_ID,
  shopDomain: 'demo-store.myshopify.com',
  shopGid: null,
  name: null,
  email: null,
  currencyCode: null,
  ianaTimezone: null,
  status: 'active',
  scopes: [],
};

function cost(overrides: Partial<ShopifyQueryCost['throttleStatus']> & { requested?: number } = {}): Record<string, unknown> {
  const { requested = 500, ...status } = overrides;
  return {
    requestedQueryCost: requested,
    actualQueryCost: null,
    throttleStatus: { maximumAvailable: 1000, currentlyAvailable: 100, restoreRate: 50, ...status },
  };
}

function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
}

const throttled = (extensionsCost: Record<string, unknown> = cost()): Response =>
  json(200, { errors: [{ message: 'Throttled', extensions: { code: 'THROTTLED' } }], extensions: { cost: extensionsCost } });

const ok = (data: unknown = { products: { nodes: [{ id: 'gid://shopify/Product/1' }] } }): Response =>
  json(200, { data, extensions: { cost: { requestedQueryCost: 3, actualQueryCost: 2, throttleStatus: { maximumAvailable: 1000, currentlyAvailable: 998, restoreRate: 50 } } } });

function setup(responses: Array<() => Response | Promise<Response>>) {
  const queue = [...responses];
  const fetchImpl = vi.fn<typeof fetch>(() => {
    const next = queue.shift();
    if (next === undefined) return Promise.reject(new Error('unexpected extra fetch call'));
    return Promise.resolve(next());
  });
  const shops = {
    requireActive: vi.fn((_shopId: string) => Promise.resolve(shopRecord)),
    getAccessToken: vi.fn((_shopId: string) => Promise.resolve('shpat_token')),
    markReauthRequired: vi.fn((_shopId: string) => Promise.resolve()),
  };
  const sleep = vi.fn((_ms: number) => Promise.resolve());
  const client = createAdminClient({ env: { SHOPIFY_API_VERSION: '2026-10' }, logger: createLogger('silent'), shops, fetchImpl, sleep });
  return { client, fetchImpl, shops, sleep };
}

describe('Admin GraphQL client', () => {
  it('posts to the pinned API version with the offline token and returns data and cost', async () => {
    const { client, fetchImpl, shops } = setup([() => ok()]);

    const result = await client.query<{ products: { nodes: Array<{ id: string }> } }>(SHOP_ID, QUERY, { first: 1 });

    expect(result.data.products.nodes[0]?.id).toBe('gid://shopify/Product/1');
    expect(result.cost).toEqual({
      requestedQueryCost: 3,
      actualQueryCost: 2,
      throttleStatus: { maximumAvailable: 1000, currentlyAvailable: 998, restoreRate: 50 },
    });
    expect(shops.getAccessToken).toHaveBeenCalledWith(SHOP_ID);

    const [url, init] = fetchImpl.mock.calls[0] ?? [];
    expect(url).toBe('https://demo-store.myshopify.com/admin/api/2026-10/graphql.json');
    expect(init?.method).toBe('POST');
    expect(Object.fromEntries(new Headers(init?.headers))).toMatchObject({
      'x-shopify-access-token': 'shpat_token',
      'content-type': 'application/json',
    });
    expect(JSON.parse(String(init?.body))).toEqual({ query: QUERY, variables: { first: 1 } });
  });

  it('returns a null cost when the response carries no cost extension', async () => {
    const { client } = setup([() => json(200, { data: { shop: { name: 'x' } } })]);
    await expect(client.query(SHOP_ID, QUERY)).resolves.toEqual({ data: { shop: { name: 'x' } }, cost: null });
  });

  it('propagates shop_reauth_required for an inactive shop without calling Shopify', async () => {
    const { client, fetchImpl, shops } = setup([]);
    shops.requireActive.mockRejectedValueOnce(AppError.shopReauthRequired());
    await expect(client.query(SHOP_ID, QUERY)).rejects.toMatchObject({ code: 'shop_reauth_required' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe('THROTTLED backoff (SPEC 8.5)', () => {
  it('waits (requested - available) / restoreRate seconds, then retries with a fresh token', async () => {
    // (500 - 100) / 50 = 8 seconds
    const { client, fetchImpl, sleep, shops } = setup([() => throttled(), () => ok()]);

    await expect(client.query(SHOP_ID, QUERY)).resolves.toMatchObject({ cost: { requestedQueryCost: 3 } });

    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledTimes(1);
    expect(sleep).toHaveBeenCalledWith(8000);
    expect(shops.getAccessToken).toHaveBeenCalledTimes(2);
  });

  it('uses the bucket numbers from the response, never an assumed plan size', async () => {
    const { client, sleep } = setup([() => throttled(cost({ requested: 2000, maximumAvailable: 20000, currentlyAvailable: 1000, restoreRate: 500 })), () => ok()]);
    await client.query(SHOP_ID, QUERY);
    expect(sleep).toHaveBeenCalledWith(2000);
  });

  it('retries at most 3 times, then fails with too_many_requests', async () => {
    const { client, fetchImpl, sleep } = setup(Array.from({ length: 10 }, () => () => throttled()));

    const error: unknown = await client.query(SHOP_ID, QUERY).catch((err: unknown) => err);

    expect(error).toBeInstanceOf(AppError);
    expect(error).toMatchObject({ code: 'too_many_requests', status: 429 });
    expect(MAX_THROTTLE_RETRIES).toBe(3);
    expect(fetchImpl).toHaveBeenCalledTimes(1 + MAX_THROTTLE_RETRIES);
    expect(sleep).toHaveBeenCalledTimes(MAX_THROTTLE_RETRIES);
  });

  it('can succeed on the last allowed retry', async () => {
    const { client, fetchImpl } = setup([() => throttled(), () => throttled(), () => throttled(), () => ok()]);
    await expect(client.query(SHOP_ID, QUERY)).resolves.toBeTruthy();
    expect(fetchImpl).toHaveBeenCalledTimes(4);
  });

  it('gives up at once when the query costs more than the whole bucket', async () => {
    const { client, fetchImpl, sleep } = setup([() => throttled(cost({ requested: 1500, maximumAvailable: 1000, currentlyAvailable: 1000 }))]);
    await expect(client.query(SHOP_ID, QUERY)).rejects.toMatchObject({ code: 'internal', status: 502 });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it('honors Retry-After on an HTTP 429', async () => {
    const { client, sleep } = setup([() => json(429, {}, { 'retry-after': '2' }), () => ok()]);
    await client.query(SHOP_ID, QUERY);
    expect(sleep).toHaveBeenCalledWith(2000);
  });

  it('falls back to a fixed wait when the throttled response has no cost data', async () => {
    const { client, sleep } = setup([() => json(200, { errors: [{ message: 'Throttled', extensions: { code: 'THROTTLED' } }] }), () => ok()]);
    await client.query(SHOP_ID, QUERY);
    expect(sleep).toHaveBeenCalledWith(1000);
  });

  it('throttleWaitMs clamps to a sane range', () => {
    const status = { maximumAvailable: 1000, currentlyAvailable: 100, restoreRate: 50 };
    const make = (requestedQueryCost: number, override: Partial<typeof status> = {}): ShopifyQueryCost => ({
      requestedQueryCost,
      actualQueryCost: null,
      throttleStatus: { ...status, ...override },
    });
    expect(throttleWaitMs(make(500))).toBe(8000);
    expect(throttleWaitMs(make(50))).toBe(100);
    expect(throttleWaitMs(make(1000, { currentlyAvailable: 0, restoreRate: 1 }))).toBe(10_000);
    expect(throttleWaitMs(make(500, { restoreRate: 0 }))).toBe(1000);
    expect(throttleWaitMs(null)).toBe(1000);
  });
});

describe('error mapping', () => {
  it('marks the shop for re-login and answers shop_reauth_required on HTTP 401', async () => {
    const { client, shops } = setup([() => json(401, { errors: '[API] Invalid API key or access token' })]);
    await expect(client.query(SHOP_ID, QUERY)).rejects.toMatchObject({ code: 'shop_reauth_required', status: 409 });
    expect(shops.markReauthRequired).toHaveBeenCalledWith(SHOP_ID);
  });

  it.each([402, 403, 423])('maps HTTP %i to forbidden', async (status) => {
    const { client } = setup([() => json(status, {})]);
    await expect(client.query(SHOP_ID, QUERY)).rejects.toMatchObject({ code: 'forbidden', status: 403 });
  });

  it.each([500, 502, 503])('maps HTTP %i to an upstream internal error without retrying', async (status) => {
    const { client, fetchImpl } = setup([() => json(status, {})]);
    await expect(client.query(SHOP_ID, QUERY)).rejects.toMatchObject({ code: 'internal', status: 502, details: { upstream: 'shopify', status } });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('maps a network failure to an upstream internal error', async () => {
    const fetchImpl = vi.fn<typeof fetch>(() => Promise.reject(new TypeError('fetch failed')));
    const client = createAdminClient({
      env: { SHOPIFY_API_VERSION: '2026-10' },
      logger: createLogger('silent'),
      shops: {
        requireActive: () => Promise.resolve(shopRecord),
        getAccessToken: () => Promise.resolve('t'),
        markReauthRequired: () => Promise.resolve(),
      },
      fetchImpl,
    });
    await expect(client.query(SHOP_ID, QUERY)).rejects.toMatchObject({ code: 'internal', status: 502 });
  });

  it('maps ACCESS_DENIED to forbidden', async () => {
    const { client } = setup([() => json(200, { errors: [{ message: 'denied', extensions: { code: 'ACCESS_DENIED' } }] })]);
    await expect(client.query(SHOP_ID, QUERY)).rejects.toMatchObject({ code: 'forbidden' });
  });

  it('maps other GraphQL errors to an upstream error with message and code only', async () => {
    const { client } = setup([
      () => json(200, { errors: [{ message: 'Field "nope" doesn\'t exist on type "Product"', locations: [{ line: 1, column: 3 }], extensions: { code: 'undefinedField' } }] }),
    ]);
    const error: unknown = await client.query(SHOP_ID, QUERY).catch((err: unknown) => err);
    expect(error).toMatchObject({
      code: 'internal',
      status: 502,
      details: { upstream: 'shopify', errors: [{ message: 'Field "nope" doesn\'t exist on type "Product"', code: 'undefinedField' }] },
    });
  });

  it('accepts a plain-string errors payload and rejects an empty or unreadable body', async () => {
    const { client } = setup([() => json(200, { errors: 'Something broke' }), () => json(200, {}), () => new Response('<html>', { status: 200 })]);
    await expect(client.query(SHOP_ID, QUERY)).rejects.toMatchObject({ code: 'internal', details: { errors: [{ message: 'Something broke' }] } });
    await expect(client.query(SHOP_ID, QUERY)).rejects.toMatchObject({ code: 'internal', status: 502 });
    await expect(client.query(SHOP_ID, QUERY)).rejects.toMatchObject({ code: 'internal', status: 502 });
  });
});
