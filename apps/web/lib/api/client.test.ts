import { ApiError } from '@rs/shared';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { REQUEST_TIMEOUT_MS, apiErrorFromResponse, apiRequest, type ClientDeps, type RequestOptions } from './client';
import { IDEMPOTENT_POST_RETRY, NO_RETRY } from './retry';

// Each step builds one fetch outcome, so a step can serve several attempts.
type Step = (init: RequestInit) => Response | Promise<Response>;

const respond =
  (status: number, body: unknown, headers: Record<string, string> = {}): Step =>
  () =>
    new Response(status === 204 ? null : JSON.stringify(body), {
      status,
      headers: { 'Content-Type': 'application/json', ...headers },
    });

const envelope = (code: string, message = 'x', details?: unknown) => ({ error: { code, message, details } });
const ok = respond(200, { value: 7 });
const unavailable = respond(503, envelope('internal', 'Down'));
const fail =
  (error: unknown): Step =>
  () => {
    throw error;
  };
// A request that never answers until its signal aborts, like a stalled connection.
const hang: Step = (init) =>
  new Promise((_, reject) => {
    const { signal } = init;
    if (signal?.aborted === true) reject(signal.reason);
    else signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
  });

function harness(steps: Step[]) {
  const calls: { url: string; init: RequestInit }[] = [];
  const sleeps: number[] = [];
  let tokens = 0;
  const deps: ClientDeps = {
    fetch: async (url, init) => {
      calls.push({ url, init });
      const step = steps[calls.length - 1] ?? steps[steps.length - 1];
      if (step === undefined) throw new Error('no step');
      return step(init);
    },
    getToken: async () => `token-${++tokens}`,
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    random: () => 0,
    now: () => Date.parse('2026-03-10T12:00:00.000Z'),
  };
  return { deps, calls, sleeps, tokens: () => tokens };
}

const schema = z.object({ value: z.number() });
const get = (overrides: Partial<RequestOptions<{ value: number }>> = {}): RequestOptions<{ value: number }> => ({
  method: 'GET',
  path: '/api/v1/thing',
  schema,
  ...overrides,
});

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => {
      throw new Error('expected a rejection');
    },
    (error: unknown) => error,
  );
}

async function apiError(promise: Promise<unknown>): Promise<ApiError> {
  const error = await rejection(promise);
  expect(error).toBeInstanceOf(ApiError);
  return error as ApiError;
}

describe('a successful request', () => {
  it('sends the bearer token and the query and returns the validated body', async () => {
    const { deps, calls } = harness([ok]);
    const result = await apiRequest(
      get({ query: { q: 'lamp', status: 'draft', cursor: undefined, limit: 25 } }),
      deps,
    );
    expect(result).toEqual({ value: 7 });
    expect(calls[0]?.url).toBe('/api/v1/thing?q=lamp&status=draft&limit=25');
    expect(new Headers(calls[0]?.init.headers).get('authorization')).toBe('Bearer token-1');
  });

  it('returns nothing for a 204 and sends a JSON body with its content type', async () => {
    const { deps, calls } = harness([respond(204, null)]);
    await expect(apiRequest({ method: 'DELETE', path: '/api/v1/media/x', body: { a: 1 } }, deps)).resolves.toBeUndefined();
    expect(calls[0]?.init.body).toBe('{"a":1}');
    expect(new Headers(calls[0]?.init.headers).get('content-type')).toBe('application/json');
  });

  it('rejects a body that does not match the schema and does not retry it', async () => {
    const { deps, calls } = harness([respond(200, { value: 'seven' })]);
    expect((await apiError(apiRequest(get(), deps))).code).toBe('invalid_response');
    expect(calls).toHaveLength(1);
  });

  it('is unauthorized, without any request, when no session token can be had', async () => {
    const { deps, calls } = harness([ok]);
    deps.getToken = () => Promise.reject(new Error('no bridge'));
    const error = await apiError(apiRequest(get(), deps));
    expect([error.status, error.code]).toEqual([401, 'unauthorized']);
    expect(calls).toHaveLength(0);
  });
});

describe('retrying a GET', () => {
  it('retries a 503 twice with 400 ms then 1.2 s of backoff, then gives up with service_unavailable', async () => {
    const { deps, calls, sleeps } = harness([unavailable]);
    const error = await apiError(apiRequest(get(), deps));
    expect([error.status, error.code]).toEqual([503, 'service_unavailable']);
    expect(calls).toHaveLength(3);
    expect(sleeps).toEqual([400, 1_200]);
  });

  it('recovers from a lost connection and a gateway error, with a fresh token per attempt', async () => {
    const { deps, calls, sleeps, tokens } = harness([fail(new TypeError('failed to fetch')), respond(502, 'bad gateway'), ok]);
    await expect(apiRequest(get(), deps)).resolves.toEqual({ value: 7 });
    expect(calls).toHaveLength(3);
    expect(sleeps).toEqual([400, 1_200]);
    expect(tokens()).toBe(3);
  });

  it('waits out a Retry-After, up to 8 s', async () => {
    const tooMany = (retryAfter: string) => respond(429, envelope('too_many_requests', 'Slow down'), { 'Retry-After': retryAfter });
    const short = harness([tooMany('2'), ok]);
    await apiRequest(get(), short.deps);
    expect(short.sleeps).toEqual([2_000]);

    const long = harness([tooMany('120'), ok]);
    await apiRequest(get(), long.deps);
    expect(long.sleeps).toEqual([8_000]);
  });

  it('adds the jitter to the backoff', async () => {
    const { deps, sleeps } = harness([unavailable, ok]);
    deps.random = () => 0.5;
    await apiRequest(get(), deps);
    expect(sleeps).toEqual([500]);
  });

  it.each([
    ['404', respond(404, envelope('not_found'))],
    ['401', respond(401, envelope('unauthorized'))],
    ['400', respond(400, envelope('validation_failed'))],
    ['envelope 500', respond(500, envelope('internal'))],
    ['the shop limit (a 429 that is not a rate limit)', respond(429, envelope('shop_limit'))],
  ])('does not retry %s', async (_name, step) => {
    const { deps, calls, sleeps } = harness([step]);
    await rejection(apiRequest(get(), deps));
    expect(calls).toHaveLength(1);
    expect(sleeps).toEqual([]);
  });

  it('keeps the error of the last attempt', async () => {
    const { deps } = harness([fail(new TypeError('a')), respond(503, 'oops'), respond(429, envelope('too_many_requests'))]);
    expect((await apiError(apiRequest(get(), deps))).code).toBe('too_many_requests');
  });
});

describe('POST and DELETE', () => {
  it('are not retried', async () => {
    for (const method of ['POST', 'DELETE'] as const) {
      const lost = harness([fail(new TypeError('failed to fetch'))]);
      expect((await apiError(apiRequest({ method, path: '/api/v1/x' }, lost.deps))).code).toBe('network_error');
      expect(lost.calls).toHaveLength(1);

      const down = harness([unavailable]);
      expect((await apiError(apiRequest({ method, path: '/api/v1/x' }, down.deps))).code).toBe('service_unavailable');
      expect(down.calls).toHaveLength(1);
    }
  });

  it('can be retried once on a lost answer when the caller says the request is idempotent', async () => {
    const retry = IDEMPOTENT_POST_RETRY;
    const recovers = harness([fail(new TypeError('failed to fetch')), ok]);
    await expect(apiRequest(get({ method: 'POST', body: {}, retry }), recovers.deps)).resolves.toEqual({ value: 7 });
    expect(recovers.calls).toHaveLength(2);

    const twice = harness([fail(new TypeError('failed to fetch'))]);
    expect((await apiError(apiRequest(get({ method: 'POST', retry }), twice.deps))).code).toBe('network_error');
    expect(twice.calls).toHaveLength(2);

    const down = harness([unavailable]);
    expect((await apiError(apiRequest(get({ method: 'POST', retry }), down.deps))).code).toBe('service_unavailable');
    expect(down.calls).toHaveLength(1);
  });
});

describe('timeouts and aborts', () => {
  it('turns a stalled request into a timeout error', async () => {
    const { deps, calls } = harness([hang]);
    const error = await apiError(apiRequest(get({ timeoutMs: 5, retry: NO_RETRY }), deps));
    expect([error.status, error.code]).toEqual([0, 'timeout']);
    expect(calls).toHaveLength(1);
  });

  it('retries a timeout like any transient failure, each attempt with its own timer', async () => {
    const { deps, calls, sleeps } = harness([hang, hang, ok]);
    await expect(apiRequest(get({ timeoutMs: 5 }), deps)).resolves.toEqual({ value: 7 });
    expect(calls).toHaveLength(3);
    expect(sleeps).toEqual([400, 1_200]);
  });

  it('times out while the body is still streaming', async () => {
    const stalled = (init: RequestInit): Response =>
      ({
        ok: true,
        status: 200,
        headers: new Headers(),
        text: () => hang(init),
      }) as unknown as Response;
    const { deps } = harness([stalled]);
    expect((await apiError(apiRequest(get({ timeoutMs: 5, retry: NO_RETRY }), deps))).code).toBe('timeout');
  });

  it('gives up after 30 s by default', () => {
    expect(REQUEST_TIMEOUT_MS).toBe(30_000);
  });

  it('keeps an abort by the caller an AbortError, not a timeout, and does not retry it', async () => {
    const controller = new AbortController();
    const { deps, calls, sleeps } = harness([hang]);
    const pending = rejection(apiRequest(get({ signal: controller.signal }), deps));
    await Promise.resolve();
    await Promise.resolve();
    controller.abort();
    const error = await pending;
    expect(error).toBeInstanceOf(DOMException);
    expect((error as DOMException).name).toBe('AbortError');
    expect(calls).toHaveLength(1);
    expect(sleeps).toEqual([]);
  });

  it('rejects at once with an AbortError when the signal is already aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    const { deps } = harness([hang]);
    const error = await rejection(apiRequest(get({ signal: controller.signal }), deps));
    expect((error as DOMException).name).toBe('AbortError');
  });

  it('stops waiting to retry when the caller aborts', async () => {
    const controller = new AbortController();
    const { deps, calls } = harness([unavailable]);
    deps.sleep = (_ms, signal) =>
      new Promise((_, reject) => {
        signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true });
      });
    const pending = rejection(apiRequest(get({ signal: controller.signal }), deps));
    await new Promise((resolve) => setTimeout(resolve, 5));
    controller.abort();
    expect(((await pending) as DOMException).name).toBe('AbortError');
    expect(calls).toHaveLength(1);
  });
});

describe('transport failures', () => {
  it('maps a failed fetch to network_error', async () => {
    const { deps } = harness([fail(new TypeError('failed to fetch'))]);
    const error = await apiError(apiRequest(get({ retry: NO_RETRY }), deps));
    expect([error.status, error.code]).toEqual([0, 'network_error']);
  });

  it('maps a body that breaks off to network_error', async () => {
    const broken = (): Response =>
      ({
        ok: true,
        status: 200,
        headers: new Headers(),
        text: () => Promise.reject(new TypeError('terminated')),
      }) as unknown as Response;
    const { deps } = harness([broken]);
    expect((await apiError(apiRequest(get({ retry: NO_RETRY }), deps))).code).toBe('network_error');
  });
});

describe('apiErrorFromResponse', () => {
  it('keeps the code, message and details of the error envelope', () => {
    const error = apiErrorFromResponse(422, envelope('references_required', 'Needs refs', { productGids: ['g'] }));
    expect([error.status, error.code, error.message]).toEqual([422, 'references_required', 'Needs refs']);
    expect(error.details).toEqual({ productGids: ['g'] });
  });

  it('maps 502, 503 and 504 to service_unavailable, with or without an envelope', () => {
    for (const status of [502, 503, 504]) {
      expect(apiErrorFromResponse(status, undefined).code).toBe('service_unavailable');
      expect(apiErrorFromResponse(status, envelope('internal', 'Down')).code).toBe('service_unavailable');
    }
    expect(apiErrorFromResponse(503, envelope('internal', 'Down')).message).toBe('Down');
  });

  it('maps any 5xx without an envelope (a proxy page) to service_unavailable', () => {
    expect(apiErrorFromResponse(500, undefined).code).toBe('service_unavailable');
    expect(apiErrorFromResponse(500, '<html>').code).toBe('service_unavailable');
    expect(apiErrorFromResponse(520, { nope: true }).code).toBe('service_unavailable');
  });

  it('keeps an envelope 500 as internal', () => {
    expect(apiErrorFromResponse(500, envelope('internal', 'Boom')).code).toBe('internal');
    expect(apiErrorFromResponse(501, envelope('not_implemented', 'Soon')).code).toBe('not_implemented');
  });

  it('keeps other answers without an envelope as internal, except 408 and 429', () => {
    expect(apiErrorFromResponse(404, undefined)).toMatchObject({ status: 404, code: 'internal' });
    expect(apiErrorFromResponse(408, undefined).code).toBe('timeout');
    expect(apiErrorFromResponse(429, undefined).code).toBe('too_many_requests');
  });

  it('stores the Retry-After of a 429 or 503 as retryAfterSec in the details', () => {
    expect(apiErrorFromResponse(429, envelope('too_many_requests'), '12').details).toEqual({ retryAfterSec: 12 });
    expect(apiErrorFromResponse(429, undefined, '5').details).toEqual({ retryAfterSec: 5 });
    expect(apiErrorFromResponse(503, undefined, '3').details).toEqual({ retryAfterSec: 3 });
    expect(apiErrorFromResponse(429, envelope('too_many_requests', 'x', { scope: 'ip' }), '9').details).toEqual({
      scope: 'ip',
      retryAfterSec: 9,
    });
    expect(
      apiErrorFromResponse(429, envelope('too_many_requests'), 'Tue, 10 Mar 2026 12:00:07 GMT', Date.parse('2026-03-10T12:00:00Z'))
        .details,
    ).toEqual({ retryAfterSec: 7 });
  });

  it('ignores a missing or invalid Retry-After and one on other statuses', () => {
    expect(apiErrorFromResponse(429, envelope('too_many_requests'), null).details).toBeUndefined();
    expect(apiErrorFromResponse(429, envelope('too_many_requests'), 'soon').details).toBeUndefined();
    expect(apiErrorFromResponse(500, envelope('internal'), '5').details).toBeUndefined();
    expect(apiErrorFromResponse(404, envelope('not_found'), '5').details).toBeUndefined();
  });

  it('does not overwrite details that are not an object', () => {
    expect(apiErrorFromResponse(429, envelope('too_many_requests', 'x', ['a']), '5').details).toEqual(['a']);
  });
});
