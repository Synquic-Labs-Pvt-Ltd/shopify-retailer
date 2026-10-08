import {
  attachMediaResponseSchema,
  batchDetailSchema,
  batchListResponseSchema,
  batchSummarySchema,
  mediaCompleteResponseSchema,
  mediaListResponseSchema,
  meResponseSchema,
  productDetailSchema,
  productListResponseSchema,
  uploadsResponseSchema,
  type Api,
} from '@rs/shared';
import { apiRequest } from './client';
import { IDEMPOTENT_POST_RETRY } from './retry';

const ATTACH_MEDIA_TIMEOUT_MS = 120_000;

// One typed function per backend endpoint the web app calls (SPEC 15). Same shape as the mobile client's
// Api, minus the auth endpoints: the web app authenticates with App Bridge session tokens only.
export type Endpoints = Omit<Api, 'auth'>;

export const endpoints: Endpoints = {
  me: () => apiRequest({ method: 'GET', path: '/api/v1/me', schema: meResponseSchema }),
  products: {
    list: (params) =>
      apiRequest({
        method: 'GET',
        path: '/api/v1/products',
        query: { q: params?.q, status: params?.status, cursor: params?.cursor, limit: params?.limit },
        schema: productListResponseSchema,
      }),
    get: (gid) =>
      apiRequest({ method: 'GET', path: `/api/v1/products/${encodeURIComponent(gid)}`, schema: productDetailSchema }),
  },
  media: {
    createUploads: (body) =>
      apiRequest({ method: 'POST', path: '/api/v1/media/uploads', body, schema: uploadsResponseSchema }),
    complete: (id) =>
      apiRequest({ method: 'POST', path: `/api/v1/media/${id}/complete`, schema: mediaCompleteResponseSchema }),
    list: (ids) =>
      apiRequest({
        method: 'GET',
        path: '/api/v1/media',
        query: { ids: ids.join(',') },
        schema: mediaListResponseSchema,
      }),
    remove: (id) => apiRequest({ method: 'DELETE', path: `/api/v1/media/${id}` }),
  },
  batches: {
    // The body carries the idempotency key of the draft, so a repeat after a lost answer returns the same batch.
    create: (body) =>
      apiRequest({
        method: 'POST',
        path: '/api/v1/batches',
        body,
        schema: batchSummarySchema,
        retry: IDEMPOTENT_POST_RETRY,
      }),
    list: (params) =>
      apiRequest({
        method: 'GET',
        path: '/api/v1/batches',
        query: { cursor: params?.cursor, limit: params?.limit },
        schema: batchListResponseSchema,
      }),
    get: (id) => apiRequest({ method: 'GET', path: `/api/v1/batches/${id}`, schema: batchDetailSchema }),
    cancel: (id) => apiRequest({ method: 'POST', path: `/api/v1/batches/${id}/cancel`, schema: batchSummarySchema }),
    retryFailed: (id) =>
      apiRequest({ method: 'POST', path: `/api/v1/batches/${id}/retry-failed`, schema: batchSummarySchema }),
    // Uploads the outputs to Shopify and adds them to the products one by one, so a big batch takes a while.
    attachMedia: (id, body) =>
      apiRequest({
        method: 'POST',
        path: `/api/v1/batches/${id}/attach-media`,
        body: body ?? {},
        schema: attachMediaResponseSchema,
        timeoutMs: ATTACH_MEDIA_TIMEOUT_MS,
      }),
  },
};
