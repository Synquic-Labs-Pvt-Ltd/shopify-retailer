import { ApiError, type Api } from '../types';
import { createMockBatchStore } from './batchStore';
import { ME, PRODUCTS, mockSession, toListItem } from './fixtures';
import { createMockMediaStore } from './mediaStore';
import { LATENCY_MS, delay } from './util';

export { mockSession } from './fixtures';

// In-memory fixtures for EXPO_PUBLIC_API_MOCK=true; the mock never talks to the backend. The pieces:
//   fixtures.ts    45 products (three pages), /me with the generation limits, the session
//   mediaStore.ts  reference uploads: staged mock:// targets, processing polls, failure demos
//   batchStore.ts  batches that advance with the clock, cancel and retry failed, admission limit
// Demo hooks: searching "error" fails the product list (error state), searching "zzz" finds nothing.

const PAGE_DEFAULT = 25;

function offsetPage<T>(all: readonly T[], cursor: string | undefined, limit: number | undefined) {
  const start = cursor === undefined ? 0 : Number.parseInt(cursor, 10) || 0;
  const page = all.slice(start, start + (limit ?? PAGE_DEFAULT));
  const end = start + page.length;
  return { page, pageInfo: { endCursor: page.length > 0 ? String(end) : null, hasNextPage: end < all.length } };
}

export function createMockApi(): Api {
  const media = createMockMediaStore();
  const batches = createMockBatchStore();

  return {
    auth: {
      exchange: async () => {
        await delay(LATENCY_MS);
        return mockSession();
      },
      refresh: async () => {
        await delay(LATENCY_MS);
        return mockSession();
      },
      logout: async () => {
        await delay(LATENCY_MS);
      },
    },
    me: async () => {
      await delay(LATENCY_MS);
      return ME;
    },
    products: {
      list: async (params) => {
        await delay(LATENCY_MS * 3);
        const query = params?.q?.trim().toLowerCase() ?? '';
        if (query === 'error') throw new ApiError(500, 'internal', 'Mock products failure');
        const matches = PRODUCTS.map((product, index) => ({ product, index })).filter(({ product }) =>
          product.title.toLowerCase().includes(query),
        );
        const { page, pageInfo } = offsetPage(matches, params?.cursor, params?.limit);
        return { items: page.map(({ product, index }) => toListItem(product, index)), pageInfo };
      },
      get: async (gid) => {
        await delay(LATENCY_MS);
        const product = PRODUCTS.find((candidate) => candidate.id === gid);
        if (product === undefined) throw new ApiError(404, 'not_found', 'Product not found');
        return product;
      },
    },
    media: {
      createUploads: async (body) => {
        await delay(LATENCY_MS);
        return media.createUploads(body);
      },
      complete: async (id) => {
        await delay(LATENCY_MS);
        return media.complete(id);
      },
      list: async (ids) => {
        await delay(LATENCY_MS);
        return { items: media.list(ids) };
      },
      remove: async (id) => {
        await delay(LATENCY_MS);
        media.remove(id);
      },
    },
    batches: {
      create: async (body) => {
        await delay(LATENCY_MS * 4);
        return batches.create(body);
      },
      list: async (params) => {
        await delay(LATENCY_MS);
        const { page, pageInfo } = offsetPage(batches.list(), params?.cursor, params?.limit);
        return { items: page, pageInfo };
      },
      get: async (id) => {
        await delay(LATENCY_MS);
        return batches.get(id);
      },
      cancel: async (id) => {
        await delay(LATENCY_MS);
        return batches.cancel(id);
      },
      retryFailed: async (id) => {
        await delay(LATENCY_MS);
        return batches.retryFailed(id);
      },
    },
  };
}
