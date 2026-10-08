import { ApiError, type Api } from '@rs/shared';
import { createMockBatchStore, type MockBatchStore } from './batchStore';
import { ME, PRODUCTS, mockSession, toListItem } from './fixtures';
import { createMockMediaStore, type MockMediaStore } from './mediaStore';
import { LATENCY_MS, delay } from './util';

export { mockSession } from './fixtures';

// In-memory fixtures for the mobile app (EXPO_PUBLIC_API_MOCK=true) and the web app (NEXT_PUBLIC_MOCK=1); the mock
// never talks to the backend. The pieces:
//   fixtures.ts    45 products (three pages), /me with the generation limits, the session
//   mediaStore.ts  reference uploads: staged mock:// targets, processing polls, failure demos
//   batchStore.ts  batches that advance with the clock, cancel and retry failed, admission limit
// Demo hooks: searching "error" fails the product list (error state), searching "zzz" finds nothing.

const PAGE_DEFAULT = 25;

export interface MockApiOptions {
  // Base latency of one call; list and create calls take a multiple of it. 0 answers without a timer.
  latencyMs?: number;
}

interface MockState {
  media: MockMediaStore;
  batches: MockBatchStore;
}

declare global {
  // The one store of the process. Kept on globalThis so it survives hot reloads of this module and is shared by
  // every route handler call of the Next server.
  var __rsMockApiState: MockState | undefined;
}

function mockState(): MockState {
  globalThis.__rsMockApiState ??= { media: createMockMediaStore(), batches: createMockBatchStore() };
  return globalThis.__rsMockApiState;
}

// Forgets every upload and batch, so the next call starts from the seeded fixtures again.
export function resetMockApi(): void {
  globalThis.__rsMockApiState = undefined;
}

function offsetPage<T>(all: readonly T[], cursor: string | undefined, limit: number | undefined) {
  const start = cursor === undefined ? 0 : Number.parseInt(cursor, 10) || 0;
  const page = all.slice(start, start + (limit ?? PAGE_DEFAULT));
  const end = start + page.length;
  return { page, pageInfo: { endCursor: page.length > 0 ? String(end) : null, hasNextPage: end < all.length } };
}

export function createMockApi(options: MockApiOptions = {}): Api {
  const latency = options.latencyMs ?? LATENCY_MS;
  const wait = (factor = 1): Promise<void> => delay(latency * factor);
  const media = (): MockMediaStore => mockState().media;
  const batches = (): MockBatchStore => mockState().batches;

  return {
    auth: {
      exchange: async () => {
        await wait();
        return mockSession();
      },
      refresh: async () => {
        await wait();
        return mockSession();
      },
      logout: async () => {
        await wait();
      },
    },
    me: async () => {
      await wait();
      return ME;
    },
    products: {
      list: async (params) => {
        await wait(3);
        const query = params?.q?.trim().toLowerCase() ?? '';
        if (query === 'error') throw new ApiError(500, 'internal', 'Mock products failure');
        const matches = PRODUCTS.map((product, index) => ({ product, index })).filter(({ product }) =>
          product.title.toLowerCase().includes(query),
        );
        const { page, pageInfo } = offsetPage(matches, params?.cursor, params?.limit);
        return { items: page.map(({ product, index }) => toListItem(product, index)), pageInfo };
      },
      get: async (gid) => {
        await wait();
        const product = PRODUCTS.find((candidate) => candidate.id === gid);
        if (product === undefined) throw new ApiError(404, 'not_found', 'Product not found');
        return product;
      },
    },
    media: {
      createUploads: async (body) => {
        await wait();
        return media().createUploads(body);
      },
      complete: async (id) => {
        await wait();
        return media().complete(id);
      },
      list: async (ids) => {
        await wait();
        return { items: media().list(ids) };
      },
      remove: async (id) => {
        await wait();
        media().remove(id);
      },
    },
    batches: {
      create: async (body) => {
        await wait(4);
        return batches().create(body);
      },
      list: async (params) => {
        await wait();
        const { page, pageInfo } = offsetPage(batches().list(), params?.cursor, params?.limit);
        return { items: page, pageInfo };
      },
      get: async (id) => {
        await wait();
        return batches().get(id);
      },
      cancel: async (id) => {
        await wait();
        return batches().cancel(id);
      },
      retryFailed: async (id) => {
        await wait();
        return batches().retryFailed(id);
      },
    },
  };
}
