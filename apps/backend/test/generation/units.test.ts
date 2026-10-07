import { describe, expect, it } from 'vitest';
import { makeAiError } from '../../src/modules/ai';
import { DownloadError, MAX_DOWNLOAD_BYTES, downloadBytes } from '../../src/modules/generation/download';
import { outcomeFromAiError } from '../../src/modules/generation';
import { recordedError } from '../batches/scripted-ai';

describe('outcomeFromAiError (SPEC 11.2)', () => {
  it.each([
    { fixture: '429-per-minute-retryinfo.json', status: 429, kind: 'defer', code: 'rate_limited', retryDelayMs: 12_000 },
    { fixture: '429-vertex-quota-per-minute-errorinfo.json', status: 429, kind: 'defer', code: 'rate_limited' },
    { fixture: '429-vertex-quota-per-day-errorinfo.json', status: 429, kind: 'defer', code: 'daily_quota' },
    { fixture: '429-per-day-aistudio.json', status: 429, kind: 'defer', code: 'daily_quota' },
    { fixture: '429-prepay-credits-depleted.json', status: 429, kind: 'defer', code: 'provider_unavailable' },
    { fixture: '403-billing-disabled.json', status: 403, kind: 'defer', code: 'provider_unavailable' },
    { fixture: '403-api-not-enabled.json', status: 403, kind: 'defer', code: 'provider_unavailable' },
    { fixture: '401-unauthenticated.json', status: 401, kind: 'defer', code: 'auth_error' },
    { fixture: '403-iam-permission-denied.json', status: 403, kind: 'defer', code: 'auth_error' },
    { fixture: '500-internal.json', status: 500, kind: 'retry', code: 'transient' },
    { fixture: '503-model-overloaded.json', status: 503, kind: 'retry', code: 'transient' },
    { fixture: '504-deadline-exceeded.json', status: 504, kind: 'retry', code: 'transient' },
    { fixture: '400-invalid-argument.json', status: 400, kind: 'failed', code: 'invalid_request' },
    { fixture: '400-veo-rai-blocked.json', status: 400, kind: 'failed', code: 'safety_blocked' },
  ] as const)('maps $fixture to $kind with code $code', ({ fixture, status, kind, code, ...rest }) => {
    const error = recordedError(status, fixture);
    const outcome = outcomeFromAiError(error);
    expect(outcome.kind).toBe(kind);
    if (outcome.kind !== 'defer' && outcome.kind !== 'retry' && outcome.kind !== 'failed') throw new Error('unexpected outcome');
    expect(outcome.error.code).toBe(code);
    expect(outcome.error.retryable).toBe(kind !== 'failed');
    expect(outcome.laneFailure).toEqual({ kind: code, retryDelayMs: error.retryDelayMs, rawBody: error.rawBody });
    expect(outcome.laneFailure?.rawBody).not.toBeNull();
    if ('retryDelayMs' in rest) expect(outcome.laneFailure?.retryDelayMs).toBe(rest.retryDelayMs);
    expect(outcome.error.httpStatus).toBe(status);
  });

  it('retries no_output (the runner limits it to one retry) and keeps provider details and the audit', () => {
    const error = makeAiError('no_output', 'No image in the response', { providerReason: 'NO_IMAGE', httpStatus: 200 });
    const audit = { promptVersion: 'abc', renderedPrompt: 'prompt' };
    expect(outcomeFromAiError(error, audit)).toEqual({
      kind: 'retry',
      error: { code: 'no_output', message: 'No image in the response', retryable: true, providerReason: 'NO_IMAGE', httpStatus: 200 },
      laneFailure: { kind: 'no_output', retryDelayMs: null, rawBody: null },
      audit,
    });
  });

  it('never marks safety_blocked or invalid_request as retryable', () => {
    for (const kind of ['safety_blocked', 'invalid_request'] as const) {
      const outcome = outcomeFromAiError(makeAiError(kind, 'nope'));
      expect(outcome).toMatchObject({ kind: 'failed', error: { code: kind, retryable: false } });
    }
  });
});

const signal = new AbortController().signal;
type Body = ConstructorParameters<typeof Response>[0];
const respond = (body: Body, init: ResponseInit = {}): typeof fetch => (async () => new Response(body, init)) as typeof fetch;

describe('downloadBytes', () => {
  it('returns the bytes with the declared mime type', async () => {
    const result = await downloadBytes(respond(new Uint8Array([1, 2, 3]), { headers: { 'content-type': 'image/png; charset=binary' } }), 'https://cdn.test/a', signal, 'image/jpeg');
    expect(result).toEqual({ bytes: new Uint8Array([1, 2, 3]), mimeType: 'image/png' });
  });

  it('falls back to the file extension, then to the given mime type', async () => {
    const plain = { headers: { 'content-type': 'application/octet-stream' } };
    expect((await downloadBytes(respond('x', plain), 'https://cdn.test/a.webp?width=1', signal, 'image/jpeg')).mimeType).toBe('image/webp');
    expect((await downloadBytes(respond('x', plain), 'https://cdn.test/clip.mp4', signal, 'image/jpeg')).mimeType).toBe('video/mp4');
    expect((await downloadBytes(respond('x', plain), 'https://cdn.test/noext', signal, 'image/jpeg')).mimeType).toBe('image/jpeg');
  });

  it('allows https only', async () => {
    for (const url of ['http://cdn.test/a.jpg', 'ftp://cdn.test/a.jpg', 'file:///etc/passwd', 'not a url']) {
      await expect(downloadBytes(respond('x'), url, signal, 'image/jpeg')).rejects.toBeInstanceOf(DownloadError);
    }
  });

  it('refuses a body over the cap, by content-length and while streaming', async () => {
    const declared = respond('x', { headers: { 'content-length': String(21 * 1024 * 1024) } });
    await expect(downloadBytes(declared, 'https://cdn.test/a', signal, 'image/jpeg')).rejects.toThrow(/larger than/);

    const streamed = respond(new Uint8Array(2048), {});
    await expect(downloadBytes(streamed, 'https://cdn.test/a', signal, 'image/jpeg', 1024)).rejects.toThrow(/larger than/);
    await expect(downloadBytes(respond(new Uint8Array(1024)), 'https://cdn.test/a', signal, 'image/jpeg', 1024)).resolves.toMatchObject({ bytes: expect.any(Uint8Array) });
    expect(MAX_DOWNLOAD_BYTES).toBe(20 * 1024 * 1024);
  });

  it('turns HTTP errors and network failures into DownloadError', async () => {
    await expect(downloadBytes(respond('gone', { status: 404 }), 'https://cdn.test/a', signal, 'image/jpeg')).rejects.toThrow(/HTTP 404/);
    const broken = (async () => {
      throw new TypeError('fetch failed');
    }) as typeof fetch;
    await expect(downloadBytes(broken, 'https://cdn.test/a', signal, 'image/jpeg')).rejects.toBeInstanceOf(DownloadError);
  });

  it('passes the abort signal to fetch', async () => {
    const controller = new AbortController();
    let seen: AbortSignal | undefined;
    const spy = (async (_url: unknown, init?: RequestInit) => {
      seen = init?.signal ?? undefined;
      return new Response('x');
    }) as typeof fetch;
    await downloadBytes(spy, 'https://cdn.test/a', controller.signal, 'image/jpeg');
    expect(seen).toBe(controller.signal);
  });
});
