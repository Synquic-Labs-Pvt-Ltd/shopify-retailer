import { describe, expect, it } from 'vitest';
import { createCreativePlanSchema } from '@rs/shared';
import type { AiPart, ImageRequest, PlanRequest, VideoPollRequest, VideoSubmitRequest } from '../../src/modules/ai';
import { buildFakePlan } from '../../src/modules/ai/fake';
import { createVertexProvider, vertexHost, vertexModelUrl } from '../../src/modules/ai/vertex';
import { at, b64, bytes, captureLogger, fixtureJson, fixtureText, httpContext, jsonResponse, recordingFetch, signal, type Responder } from './helpers';

const PROJECT = 'test-proj';

function setup(respond: Responder, overrides: { project?: string | undefined; getAccessToken?: () => Promise<string> } = {}) {
  const { fetchImpl, calls } = recordingFetch(respond);
  const log = captureLogger();
  const provider = createVertexProvider({
    http: httpContext('vertex', fetchImpl, log.logger),
    project: 'project' in overrides ? overrides.project : PROJECT,
    getAccessToken: overrides.getAccessToken ?? (async () => 'token-123'),
  });
  return { provider, calls, log };
}

const textPart = (text: string): AiPart => ({ kind: 'text', text });
const imagePart = (...data: number[]): AiPart => ({ kind: 'inlineData', mimeType: 'image/jpeg', data: bytes(...data) });

function planRequest(overrides: Partial<PlanRequest> = {}): PlanRequest {
  return {
    model: 'gemini-2.5-flash',
    location: 'us-central1',
    signal: signal(),
    systemPrompt: 'SYSTEM PROMPT',
    parts: [textPart('PRODUCT DATA'), imagePart(1, 2, 3), { kind: 'fileData', mimeType: 'video/mp4', uri: 'https://cdn.shopify.com/v.mp4' }],
    imageCount: 2,
    videoCount: 1,
    temperature: 0.6,
    ...overrides,
  };
}

function imageRequest(overrides: Partial<ImageRequest> = {}): ImageRequest {
  return {
    model: 'gemini-2.5-flash-image',
    location: 'us-central1',
    signal: signal(),
    parts: [textPart('PRODUCT IMAGE 1'), imagePart(5), textPart('PROMPT')],
    aspectRatio: '3:4',
    imageSize: '2K',
    outputMimeType: 'image/jpeg',
    ...overrides,
  };
}

function videoRequest(overrides: Partial<VideoSubmitRequest> = {}): VideoSubmitRequest {
  return {
    model: 'veo-3.1-generate-001',
    location: 'us-central1',
    signal: signal(),
    prompt: 'A lamp glows.',
    negativePrompt: 'text, watermark',
    referenceImages: [{ mimeType: 'image/jpeg', data: bytes(1, 2) }],
    durationSeconds: 8,
    aspectRatio: '9:16',
    resolution: '720p',
    generateAudio: false,
    personGeneration: 'allow_adult',
    sampleCount: 1,
    ...overrides,
  };
}

const pollRequest = (overrides: Partial<VideoPollRequest> = {}): VideoPollRequest => ({
  model: 'veo-3.1-generate-001',
  location: 'us-central1',
  signal: signal(),
  operationName: 'projects/test-proj/locations/us-central1/publishers/google/models/veo-3.1-generate-001/operations/op-1',
  ...overrides,
});

function imageSuccess(data: number[] = [255, 216, 255]): Response {
  return jsonResponse(200, {
    candidates: [{ content: { role: 'model', parts: [{ inlineData: { mimeType: 'image/jpeg', data: b64(bytes(...data)) } }] }, finishReason: 'STOP' }],
    responseId: 'resp-img',
    modelVersion: 'gemini-2.5-flash-image-001',
  });
}

describe('vertex URLs', () => {
  it('uses the regional host for a location and the global host for "global"', () => {
    expect(vertexHost('us-central1')).toBe('us-central1-aiplatform.googleapis.com');
    expect(vertexHost('global')).toBe('aiplatform.googleapis.com');
    expect(vertexModelUrl('p', 'global', 'm', 'generateContent')).toBe(
      'https://aiplatform.googleapis.com/v1/projects/p/locations/global/publishers/google/models/m:generateContent',
    );
  });
});

describe('vertex plan', () => {
  it('posts generateContent with a system instruction and a JSON response schema', async () => {
    const plan = buildFakePlan({ imageCount: 2, videoCount: 1 });
    const { provider, calls } = setup(() =>
      jsonResponse(200, { candidates: [{ content: { parts: [{ text: JSON.stringify(plan) }] }, finishReason: 'STOP' }], responseId: 'resp-plan', modelVersion: 'gemini-2.5-flash-002' }),
    );

    const result = await provider.plan(planRequest());

    expect(calls).toHaveLength(1);
    const call = calls[0];
    expect(call?.url).toBe(
      'https://us-central1-aiplatform.googleapis.com/v1/projects/test-proj/locations/us-central1/publishers/google/models/gemini-2.5-flash:generateContent',
    );
    expect(call?.method).toBe('POST');
    expect(call?.headers).toEqual({ 'content-type': 'application/json', authorization: 'Bearer token-123' });

    const body = call?.body;
    expect(at(body, 'systemInstruction')).toEqual({ parts: [{ text: 'SYSTEM PROMPT' }] });
    expect(at(body, 'contents')).toEqual([
      {
        role: 'user',
        parts: [
          { text: 'PRODUCT DATA' },
          { inlineData: { mimeType: 'image/jpeg', data: b64(bytes(1, 2, 3)) } },
          { fileData: { mimeType: 'video/mp4', fileUri: 'https://cdn.shopify.com/v.mp4' } },
        ],
      },
    ]);
    expect(at(body, 'generationConfig', 'temperature')).toBe(0.6);
    expect(at(body, 'generationConfig', 'responseMimeType')).toBe('application/json');
    expect(at(body, 'generationConfig', 'responseSchema', 'type')).toBe('OBJECT');
    expect(at(body, 'generationConfig', 'responseSchema', 'properties', 'imageShots')).toMatchObject({ minItems: 2, maxItems: 2 });
    expect(at(body, 'generationConfig', 'responseSchema', 'properties', 'videoShots')).toMatchObject({ minItems: 1, maxItems: 1 });

    expect(result).toMatchObject({ ok: true, value: { json: plan, responseId: 'resp-plan', modelVersion: 'gemini-2.5-flash-002' } });
    if (result.ok) expect(createCreativePlanSchema({ imageCount: 2, videoCount: 1 }).safeParse(result.value.json).success).toBe(true);
  });

  it('uses the global host and location path for a global model', async () => {
    const { provider, calls } = setup(() => jsonResponse(200, { candidates: [{ content: { parts: [{ text: '{}' }] } }] }));
    await provider.plan(planRequest({ model: 'gemini-3.1-flash-preview', location: 'global' }));
    expect(calls[0]?.url).toBe(
      'https://aiplatform.googleapis.com/v1/projects/test-proj/locations/global/publishers/google/models/gemini-3.1-flash-preview:generateContent',
    );
  });
});

describe('vertex image', () => {
  it('requests IMAGE+TEXT with aspect ratio, size and JPEG output options', async () => {
    const { provider, calls } = setup(() => imageSuccess([1, 2, 3, 4]));
    const result = await provider.generateImage(imageRequest());

    const body = calls[0]?.body;
    expect(calls[0]?.url).toBe(
      'https://us-central1-aiplatform.googleapis.com/v1/projects/test-proj/locations/us-central1/publishers/google/models/gemini-2.5-flash-image:generateContent',
    );
    expect(at(body, 'generationConfig')).toEqual({
      responseModalities: ['IMAGE', 'TEXT'],
      imageConfig: { aspectRatio: '3:4', imageSize: '2K', imageOutputOptions: { mimeType: 'image/jpeg', compressionQuality: 90 } },
    });
    expect(at(body, 'contents', 0, 'parts')).toEqual([
      { text: 'PRODUCT IMAGE 1' },
      { inlineData: { mimeType: 'image/jpeg', data: b64(bytes(5)) } },
      { text: 'PROMPT' },
    ]);
    expect(at(body, 'systemInstruction')).toBeUndefined();
    expect(result).toMatchObject({ ok: true, value: { mimeType: 'image/jpeg', responseId: 'resp-img', modelVersion: 'gemini-2.5-flash-image-001' } });
    if (result.ok) expect([...result.value.bytes]).toEqual([1, 2, 3, 4]);
  });

  it('omits the JPEG compression quality for PNG output', async () => {
    const { provider, calls } = setup(() => imageSuccess());
    await provider.generateImage(imageRequest({ outputMimeType: 'image/png' }));
    expect(at(calls[0]?.body, 'generationConfig', 'imageConfig', 'imageOutputOptions')).toEqual({ mimeType: 'image/png' });
  });

  it('retries once without imageSize and output options when the model rejects them, then remembers', async () => {
    const { provider, calls, log } = setup((_call, index) =>
      index === 0 ? jsonResponse(400, fixtureText('400-image-size-unsupported.json')) : imageSuccess(),
    );

    const first = await provider.generateImage(imageRequest());
    expect(first.ok).toBe(true);
    expect(calls).toHaveLength(2);
    expect(at(calls[0]?.body, 'generationConfig', 'imageConfig', 'imageSize')).toBe('2K');
    expect(at(calls[1]?.body, 'generationConfig', 'imageConfig')).toEqual({ aspectRatio: '3:4' });

    const second = await provider.generateImage(imageRequest());
    expect(second.ok).toBe(true);
    expect(calls).toHaveLength(3);
    expect(at(calls[2]?.body, 'generationConfig', 'imageConfig')).toEqual({ aspectRatio: '3:4' });
    expect(log.lines.some((line) => line.msg === 'ai provider call failed' && String(line.body).includes('imageSize'))).toBe(true);
  });

  it('does not retry unrelated 400s', async () => {
    const { provider, calls } = setup(() => jsonResponse(400, fixtureText('400-invalid-argument.json')));
    const result = await provider.generateImage(imageRequest());
    expect(calls).toHaveLength(1);
    expect(result).toMatchObject({ ok: false, error: { kind: 'invalid_request' } });
  });

  it('maps a 200 without an image to safety_blocked or no_output', async () => {
    const blocked = setup(() => jsonResponse(200, fixtureText('200-image-safety.json')));
    expect(await blocked.provider.generateImage(imageRequest())).toMatchObject({ ok: false, error: { kind: 'safety_blocked' } });
    const none = setup(() => jsonResponse(200, fixtureText('200-no-image-text-only.json')));
    expect(await none.provider.generateImage(imageRequest())).toMatchObject({ ok: false, error: { kind: 'no_output' } });
  });
});

describe('vertex video', () => {
  it('submits predictLongRunning with reference images of type asset and the configured parameters', async () => {
    const operation = 'projects/test-proj/locations/us-central1/publishers/google/models/veo-3.1-generate-001/operations/op-1';
    const { provider, calls } = setup(() => jsonResponse(200, { name: operation }));

    const result = await provider.submitVideo(videoRequest());

    expect(calls[0]?.url).toBe(
      'https://us-central1-aiplatform.googleapis.com/v1/projects/test-proj/locations/us-central1/publishers/google/models/veo-3.1-generate-001:predictLongRunning',
    );
    expect(calls[0]?.headers.authorization).toBe('Bearer token-123');
    expect(calls[0]?.body).toEqual({
      instances: [
        {
          prompt: 'A lamp glows.',
          referenceImages: [{ image: { bytesBase64Encoded: b64(bytes(1, 2)), mimeType: 'image/jpeg' }, referenceType: 'asset' }],
        },
      ],
      parameters: {
        aspectRatio: '9:16',
        durationSeconds: 8,
        resolution: '720p',
        generateAudio: false,
        personGeneration: 'allow_adult',
        sampleCount: 1,
        negativePrompt: 'text, watermark',
      },
    });
    expect(result).toEqual({ ok: true, value: { operationName: operation } });
  });

  it('sends at most three reference images and omits an empty negative prompt', async () => {
    const { provider, calls } = setup(() => jsonResponse(200, { name: 'op' }));
    const referenceImages = [1, 2, 3, 4, 5].map((n) => ({ mimeType: 'image/png', data: bytes(n) }));
    await provider.submitVideo(videoRequest({ referenceImages, negativePrompt: '' }));
    expect(at(calls[0]?.body, 'instances', 0, 'referenceImages')).toHaveLength(3);
    expect(at(calls[0]?.body, 'parameters', 'negativePrompt')).toBeUndefined();
  });

  it('omits referenceImages when none are given', async () => {
    const { provider, calls } = setup(() => jsonResponse(200, { name: 'op' }));
    await provider.submitVideo(videoRequest({ referenceImages: [] }));
    expect(at(calls[0]?.body, 'instances', 0)).toEqual({ prompt: 'A lamp glows.' });
  });

  it('fails clearly when the submit response has no operation name', async () => {
    const { provider } = setup(() => jsonResponse(200, {}));
    expect(await provider.submitVideo(videoRequest())).toMatchObject({ ok: false, error: { kind: 'no_output' } });
  });

  it('polls with fetchPredictOperation and reports pending operations', async () => {
    const { provider, calls } = setup(() => jsonResponse(200, { name: 'op', metadata: {} }));
    const request = pollRequest();
    const result = await provider.pollVideo(request);
    expect(result).toEqual({ ok: true, value: { done: false } });
    expect(calls[0]?.url).toBe(
      'https://us-central1-aiplatform.googleapis.com/v1/projects/test-proj/locations/us-central1/publishers/google/models/veo-3.1-generate-001:fetchPredictOperation',
    );
    expect(calls[0]?.method).toBe('POST');
    expect(calls[0]?.body).toEqual({ operationName: request.operationName });
  });

  it('polls the project, location and model embedded in the operation name, not the current config', async () => {
    const { provider, calls } = setup(() => jsonResponse(200, { done: false }));
    await provider.pollVideo(
      pollRequest({
        model: 'veo-3.1-fast-generate-001',
        location: 'europe-west4',
        operationName: 'projects/123456789012/locations/us-east5/publishers/google/models/veo-3.1-generate-001/operations/op-9',
      }),
    );
    expect(calls[0]?.url).toBe(
      'https://us-east5-aiplatform.googleapis.com/v1/projects/123456789012/locations/us-east5/publishers/google/models/veo-3.1-generate-001:fetchPredictOperation',
    );
  });

  it('falls back to the requested location and model for an unrecognised operation name', async () => {
    const { provider, calls } = setup(() => jsonResponse(200, { done: false }));
    await provider.pollVideo(pollRequest({ operationName: 'operations/opaque-id' }));
    expect(calls[0]?.url).toContain('/projects/test-proj/locations/us-central1/publishers/google/models/veo-3.1-generate-001:fetchPredictOperation');
  });

  it('returns the inline video bytes when the operation is done', async () => {
    const mp4 = bytes(0, 0, 0, 24, 102, 116, 121, 112);
    const { provider } = setup(() =>
      jsonResponse(200, { name: 'op', done: true, response: { videos: [{ bytesBase64Encoded: b64(mp4), mimeType: 'video/mp4' }], raiMediaFilteredCount: 0 } }),
    );
    const result = await provider.pollVideo(pollRequest());
    expect(result).toMatchObject({ ok: true, value: { done: true, video: { mimeType: 'video/mp4' } } });
    if (result.ok && result.value.done) expect([...result.value.video.bytes]).toEqual([...mp4]);
  });

  it('returns a clear error when only a Cloud Storage URI comes back', async () => {
    const { provider } = setup(() =>
      jsonResponse(200, { done: true, response: { videos: [{ gcsUri: 'gs://bucket/out/video.mp4', mimeType: 'video/mp4' }] } }),
    );
    const result = await provider.pollVideo(pollRequest());
    expect(result).toMatchObject({ ok: false, error: { kind: 'invalid_request', providerReason: 'storage_uri_only', retryable: false } });
    if (!result.ok) expect(result.error.message).toMatch(/Cloud Storage URI \(gs:\/\/bucket\/out\/video\.mp4\)/);
  });

  it('maps a filtered operation to safety_blocked', async () => {
    const { provider } = setup(() => jsonResponse(200, fixtureJson('200-veo-rai-filtered.json')));
    const result = await provider.pollVideo(pollRequest());
    expect(result).toMatchObject({ ok: false, error: { kind: 'safety_blocked', providerReason: 'rai_media_filtered', retryable: false } });
    if (!result.ok) expect(result.error.message).toMatch(/Support codes: 29310472/);
  });

  it('classifies a done operation that carries an error', async () => {
    const { provider } = setup(() => jsonResponse(200, { done: true, error: { code: 14, message: 'The service is currently unavailable.' } }));
    expect(await provider.pollVideo(pollRequest())).toMatchObject({ ok: false, error: { kind: 'transient' } });
  });

  it('reports no_output when the operation finishes without a video', async () => {
    const { provider } = setup(() => jsonResponse(200, { done: true, response: {} }));
    expect(await provider.pollVideo(pollRequest())).toMatchObject({ ok: false, error: { kind: 'no_output' } });
  });
});

describe('vertex failures never throw', () => {
  it('classifies a 429 from the raw body, keeps Retry-After, and logs the full body', async () => {
    const { provider, log } = setup(() => jsonResponse(429, fixtureText('429-per-minute-retryinfo.json'), { 'retry-after': '30' }));
    const result = await provider.plan(planRequest());
    expect(result).toMatchObject({ ok: false, error: { kind: 'rate_limited', httpStatus: 429, retryDelayMs: 12000 } });
    const entry = log.lines.find((line) => line.msg === 'ai provider call failed');
    expect(entry).toMatchObject({ provider: 'vertex', status: 429, kind: 'rate_limited', op: 'vertex.generateContent.plan' });
    expect(String(entry?.body)).toContain('GenerateRequestsPerMinutePerProjectPerModel-FreeTier');
  });

  it('classifies a prepaid-credits 429 as provider_unavailable at error level', async () => {
    const { provider, log } = setup(() => jsonResponse(429, fixtureText('429-prepay-credits-depleted.json')));
    const result = await provider.generateImage(imageRequest());
    expect(result).toMatchObject({ ok: false, error: { kind: 'provider_unavailable' } });
    expect(log.lines.find((line) => line.msg === 'ai provider call failed')?.level).toBe(50);
  });

  it('classifies 5xx and a non-JSON 200 as transient', async () => {
    const down = setup(() => jsonResponse(503, fixtureText('503-model-overloaded.json')));
    expect(await down.provider.submitVideo(videoRequest())).toMatchObject({ ok: false, error: { kind: 'transient' } });
    const garbled = setup(() => new Response('<html>oops</html>', { status: 200 }));
    expect(await garbled.provider.plan(planRequest())).toMatchObject({ ok: false, error: { kind: 'transient' } });
  });

  it('maps an aborted request to transient with reason timeout', async () => {
    const controller = new AbortController();
    controller.abort(new DOMException('The operation timed out', 'TimeoutError'));
    const { provider } = setup(() => jsonResponse(200, {}));
    const result = await provider.plan(planRequest({ signal: controller.signal }));
    expect(result).toMatchObject({ ok: false, error: { kind: 'transient', providerReason: 'timeout' } });
  });

  it('maps a fetch failure to transient', async () => {
    const { provider } = setup(() => {
      throw new TypeError('fetch failed');
    });
    expect(await provider.generateImage(imageRequest())).toMatchObject({ ok: false, error: { kind: 'transient', providerReason: 'network_error' } });
  });

  it('returns auth_error without calling the API when the project is missing', async () => {
    const { provider, calls } = setup(() => jsonResponse(200, {}), { project: undefined });
    expect(await provider.plan(planRequest())).toMatchObject({ ok: false, error: { kind: 'auth_error', providerReason: 'missing_project' } });
    expect(calls).toHaveLength(0);
  });

  it('returns auth_error when the access token cannot be obtained', async () => {
    const { provider, calls } = setup(() => jsonResponse(200, {}), {
      getAccessToken: async () => {
        throw new Error('invalid_grant: account not found');
      },
    });
    const result = await provider.generateImage(imageRequest());
    expect(result).toMatchObject({ ok: false, error: { kind: 'auth_error', providerReason: 'token_error' } });
    expect(calls).toHaveLength(0);
  });

  it('treats a token fetch network failure as transient', async () => {
    const { provider } = setup(() => jsonResponse(200, {}), {
      getAccessToken: async () => {
        throw Object.assign(new Error('getaddrinfo ENOTFOUND oauth2.googleapis.com'), { code: 'ENOTFOUND' });
      },
    });
    expect(await provider.plan(planRequest())).toMatchObject({ ok: false, error: { kind: 'transient' } });
  });

  it('refuses a location or model that could change the request host', async () => {
    const { provider, calls } = setup(() => jsonResponse(200, {}));
    const result = await provider.plan(planRequest({ location: 'evil.example.com/x' }));
    expect(result).toMatchObject({ ok: false, error: { kind: 'invalid_request' } });
    expect(calls).toHaveLength(0);
  });
});
