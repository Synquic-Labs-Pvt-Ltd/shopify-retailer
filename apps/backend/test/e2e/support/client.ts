import { createHash, createHmac, randomBytes, randomUUID } from 'node:crypto';
import request from 'supertest';
import {
  authSessionResponseSchema,
  batchDetailSchema,
  errorEnvelopeSchema,
  mediaListResponseSchema,
  mediaObjectSchema,
  uploadsResponseSchema,
  type AuthSessionResponse,
  type BatchDetail,
  type CreateBatchInput,
  type MediaObject,
  type UploadTarget,
} from '@rs/shared';
import type { E2e } from './harness';
import type { ApproveOptions } from './shopify-stub';
import { waitFor } from './wait';

export interface Pkce {
  verifier: string;
  challenge: string;
}

export function createPkce(): Pkce {
  const verifier = randomBytes(32).toString('base64url');
  return { verifier, challenge: createHash('sha256').update(verifier).digest('base64url') };
}

// The merchant's browser session: every redirect Location the backend answered, in order.
export interface BrowserFlow {
  pkce: Pkce;
  locations: string[];
  code: string;
}

// GET /auth/shopify/start, then approve every Shopify authorize URL and follow the callback, until the
// backend redirects to the app deep link.
export async function browserFlow(e2e: E2e, shopDomain: string, approve: ApproveOptions = {}): Promise<BrowserFlow> {
  const pkce = createPkce();
  const start = await request(e2e.app).get('/auth/shopify/start').query({ shop: shopDomain, challenge: pkce.challenge });
  if (start.status !== 302) throw new Error(`start answered ${start.status}: ${start.text}`);
  const locations = [String(start.headers.location)];

  for (let hop = 0; hop < 4; hop += 1) {
    const location = locations[locations.length - 1] ?? '';
    if (!location.startsWith('https://')) break;
    const callback = await request(e2e.app).get(e2e.stub.approve(location, approve));
    if (callback.status !== 302) throw new Error(`callback answered ${callback.status}: ${callback.text}`);
    locations.push(String(callback.headers.location));
  }
  const code = new URL(locations[locations.length - 1] ?? '').searchParams.get('code');
  if (code === null) throw new Error(`The flow ended without a login code: ${locations.join(' -> ')}`);
  return { pkce, locations, code };
}

export function exchangeRequest(e2e: E2e, flow: BrowserFlow, overrides: Record<string, unknown> = {}): request.Test {
  return request(e2e.app)
    .post('/api/v1/auth/exchange')
    .send({ code: flow.code, codeVerifier: flow.pkce.verifier, platform: 'android', deviceName: 'Pixel 8', ...overrides });
}

export interface ApiClient {
  readonly shopDomain: string;
  session: AuthSessionResponse;
  get(path: string): request.Test;
  post(path: string, body?: object): request.Test;
  delete(path: string): request.Test;
}

export function apiClient(e2e: E2e, session: AuthSessionResponse): ApiClient {
  const authorize = (test: request.Test): request.Test => test.set('authorization', `Bearer ${client.session.accessToken}`);
  const client: ApiClient = {
    shopDomain: session.shop.domain,
    session,
    get: (path) => authorize(request(e2e.app).get(path)),
    post: (path, body) => authorize(request(e2e.app).post(path)).send(body ?? {}),
    delete: (path) => authorize(request(e2e.app).delete(path)),
  };
  return client;
}

// Logs a merchant in through the browser flow and the code exchange.
export async function login(e2e: E2e, shopDomain: string, approve: ApproveOptions = {}): Promise<ApiClient> {
  const flow = await browserFlow(e2e, shopDomain, approve);
  const res = await exchangeRequest(e2e, flow);
  if (res.status !== 200) throw new Error(`exchange answered ${res.status}: ${res.text}`);
  return apiClient(e2e, authSessionResponseSchema.parse(res.body));
}

// Shopify signs the exact bytes of a webhook body with the app secret (base64 HMAC-SHA256).
export function sendWebhook(
  e2e: E2e,
  delivery: { topic: string; shop: string; id?: string; payload?: object; secret?: string },
): request.Test {
  const body = JSON.stringify(delivery.payload ?? { shop_domain: delivery.shop });
  return request(e2e.app)
    .post('/webhooks/shopify')
    .set('content-type', 'application/json')
    .set('x-shopify-topic', delivery.topic)
    .set('x-shopify-shop-domain', delivery.shop)
    .set('x-shopify-webhook-id', delivery.id ?? randomUUID())
    .set('x-shopify-api-version', '2026-10')
    .set('x-shopify-hmac-sha256', createHmac('sha256', delivery.secret ?? e2e.env.SHOPIFY_API_SECRET).update(body).digest('base64'))
    .send(body);
}

// What the mobile app does for one reference: ask for a target, post the multipart form to it, complete.
export interface UploadSpec {
  clientId: string;
  filename: string;
  mimeType: string;
  bytes: Uint8Array;
  scope: 'common' | 'product';
  productGid?: string;
  durationSec?: number;
}

export function uploadsBody(specs: UploadSpec[]): object {
  return {
    files: specs.map((spec) => ({
      clientId: spec.clientId,
      filename: spec.filename,
      mimeType: spec.mimeType,
      fileSize: spec.bytes.byteLength,
      scope: spec.scope,
      ...(spec.productGid === undefined ? {} : { productGid: spec.productGid }),
      ...(spec.durationSec === undefined ? {} : { durationSec: spec.durationSec }),
    })),
  };
}

// Every parameter first, the file last, as the staged target requires.
export function postToTarget(target: UploadTarget, spec: UploadSpec): Promise<Response> {
  const form = new FormData();
  for (const parameter of target.parameters) form.append(parameter.name, parameter.value);
  form.append('file', new Blob([new Uint8Array(spec.bytes)], { type: spec.mimeType }), spec.filename);
  return fetch(target.url, { method: target.method, body: form });
}

export async function uploadReferences(client: ApiClient, specs: UploadSpec[]): Promise<MediaObject[]> {
  const res = await client.post('/api/v1/media/uploads', uploadsBody(specs));
  if (res.status !== 200) throw new Error(`uploads answered ${res.status}: ${res.text}`);
  const { targets } = uploadsResponseSchema.parse(res.body);

  const completed: MediaObject[] = [];
  for (const spec of specs) {
    const target = targets.find((candidate) => candidate.clientId === spec.clientId);
    if (target === undefined) throw new Error(`No upload target for ${spec.clientId}`);
    const posted = await postToTarget(target, spec);
    if (posted.status !== 201) throw new Error(`The staged upload answered ${posted.status}`);
    const done = await client.post(`/api/v1/media/${target.mediaId}/complete`);
    if (done.status !== 200) throw new Error(`complete answered ${done.status}: ${done.text}`);
    completed.push(mediaObjectSchema.parse(done.body));
  }
  return completed;
}

// Polls GET /media like the app does, until every asset left processing.
export async function waitMediaSettled(client: ApiClient, ids: string[], timeoutMs = 30_000): Promise<MediaObject[]> {
  return waitFor(
    async () => {
      const res = await client.get(`/api/v1/media?ids=${ids.join(',')}`);
      if (res.status !== 200) throw new Error(`GET /media answered ${res.status}: ${res.text}`);
      const { items } = mediaListResponseSchema.parse(res.body);
      return items.length === ids.length && items.every((item) => item.status !== 'processing' && item.status !== 'awaiting_upload') ? items : null;
    },
    { timeoutMs, intervalMs: 400, label: 'references to leave processing' },
  );
}

export async function uploadReadyReferences(client: ApiClient, specs: UploadSpec[]): Promise<MediaObject[]> {
  const completed = await uploadReferences(client, specs);
  const settled = await waitMediaSettled(
    client,
    completed.map((item) => item.id),
  );
  const bad = settled.filter((item) => item.status !== 'ready');
  if (bad.length > 0) throw new Error(`References did not become ready: ${JSON.stringify(bad)}`);
  return settled;
}

export async function createBatch(client: ApiClient, body: Omit<CreateBatchInput, 'idempotencyKey'> & { idempotencyKey?: string }): Promise<request.Response> {
  return client.post('/api/v1/batches', { idempotencyKey: randomUUID(), ...body });
}

export async function getBatch(client: ApiClient, batchId: string): Promise<BatchDetail> {
  const res = await client.get(`/api/v1/batches/${batchId}`);
  if (res.status !== 200) throw new Error(`GET /batches/${batchId} answered ${res.status}: ${res.text}`);
  return batchDetailSchema.parse(res.body);
}

// The error envelope of a failed response (SPEC 15).
export function errorOf(res: request.Response): { code: string; message: string; details?: unknown } {
  return errorEnvelopeSchema.parse(res.body).error;
}

export const commonImageSpec = (clientId: string, bytes: Uint8Array): UploadSpec => ({
  clientId,
  filename: `${clientId}.jpg`,
  mimeType: 'image/jpeg',
  bytes,
  scope: 'common',
});

export function defined<T>(value: T | null | undefined, label = 'value'): T {
  if (value === null || value === undefined) throw new Error(`Expected ${label} to be defined`);
  return value;
}
