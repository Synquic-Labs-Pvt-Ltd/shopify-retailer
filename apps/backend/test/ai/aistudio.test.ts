import { describe, expect, it } from 'vitest';
import type { ImageRequest, PlanRequest, VideoPollRequest, VideoSubmitRequest } from '../../src/modules/ai';
import { buildFakePlan } from '../../src/modules/ai/fake';
import { AI_STUDIO_BASE_URL, createAiStudioProvider } from '../../src/modules/ai/aistudio';
import { at, b64, bytes, captureLogger, fixtureJson, fixtureText, httpContext, jsonResponse, recordingFetch, signal, type Responder } from './helpers';

const API_KEY = 'test-api-key';
const OPERATION = 'models/veo-3.1-generate-preview/operations/op-abc';
const VIDEO_URI = 'https://generativelanguage.googleapis.com/v1beta/files/video-1:download?alt=media';

function setup(respond: Responder, options: { apiKey?: string | undefined } = {}) {
  const { fetchImpl, calls } = recordingFetch(respond);
  const log = captureLogger();
  const apiKey = 'apiKey' in options ? options.apiKey : API_KEY;
  const provider = createAiStudioProvider({ http: httpContext('aistudio', fetchImpl, log.logger), apiKey });
  return { provider, calls, log };
}

function planRequest(): PlanRequest {
  return {
    model: 'gemini-2.5-flash',
    location: 'us-central1',
    signal: signal(),
    systemPrompt: 'SYSTEM',
    parts: [{ kind: 'text', text: 'PRODUCT DATA' }, { kind: 'inlineData', mimeType: 'image/png', data: bytes(1, 2) }],
    imageCount: 2,
    videoCount: 1,
    temperature: 0.6,
  };
}

function imageRequest(): ImageRequest {
  return {
    model: 'gemini-2.5-flash-image',
    location: 'us-central1',
    signal: signal(),
    parts: [{ kind: 'text', text: 'PROMPT' }],
    aspectRatio: '3:4',
    imageSize: '2K',
    outputMimeType: 'image/jpeg',
  };
}

function videoRequest(): VideoSubmitRequest {
  return {
    model: 'veo-3.1-generate-preview',
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
  };
}

const pollRequest = (operationName = OPERATION): VideoPollRequest => ({
  model: 'veo-3.1-generate-preview',
  location: 'us-central1',
  signal: signal(),
  operationName,
});

describe('aistudio plan', () => {
  it('posts generateContent to the Gemini API with the key header and a JSON schema', async () => {
    const plan = buildFakePlan({ imageCount: 2, videoCount: 1 });
    const { provider, calls } = setup(() => jsonResponse(200, { candidates: [{ content: { parts: [{ text: JSON.stringify(plan) }] } }], responseId: 'r1', modelVersion: 'v1' }));

    const result = await provider.plan(planRequest());

    expect(calls[0]?.url).toBe('https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent');
    expect(calls[0]?.headers).toEqual({ 'content-type': 'application/json', 'x-goog-api-key': API_KEY });
    expect(at(calls[0]?.body, 'systemInstruction')).toEqual({ parts: [{ text: 'SYSTEM' }] });
    expect(at(calls[0]?.body, 'generationConfig', 'responseMimeType')).toBe('application/json');
    expect(at(calls[0]?.body, 'generationConfig', 'responseSchema', 'type')).toBe('OBJECT');
    expect(at(calls[0]?.body, 'contents', 0, 'parts', 1)).toEqual({ inlineData: { mimeType: 'image/png', data: b64(bytes(1, 2)) } });
    expect(result).toMatchObject({ ok: true, value: { json: plan, responseId: 'r1', modelVersion: 'v1' } });
  });

  it('ignores the Vertex location and never sends a bearer token', async () => {
    const { provider, calls } = setup(() => jsonResponse(200, { candidates: [{ content: { parts: [{ text: '{}' }] } }] }));
    await provider.plan({ ...planRequest(), location: 'global' });
    expect(calls[0]?.url).not.toContain('global');
    expect(calls[0]?.headers.authorization).toBeUndefined();
  });
});

describe('aistudio image', () => {
  it('sends aspect ratio and size but no JPEG output options', async () => {
    const { provider, calls } = setup(() =>
      jsonResponse(200, { candidates: [{ content: { parts: [{ inlineData: { mimeType: 'image/png', data: b64(bytes(4, 5)) } }] }, finishReason: 'STOP' }], responseId: 'ri' }),
    );
    const result = await provider.generateImage(imageRequest());
    expect(calls[0]?.url).toBe('https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-image:generateContent');
    expect(at(calls[0]?.body, 'generationConfig')).toEqual({
      responseModalities: ['IMAGE', 'TEXT'],
      imageConfig: { aspectRatio: '3:4', imageSize: '2K' },
    });
    expect(result).toMatchObject({ ok: true, value: { mimeType: 'image/png', responseId: 'ri' } });
  });

  it('retries once without imageSize when the model rejects it', async () => {
    const { provider, calls } = setup((_call, index) =>
      index === 0
        ? jsonResponse(400, fixtureText('400-image-size-unsupported.json'))
        : jsonResponse(200, { candidates: [{ content: { parts: [{ inlineData: { mimeType: 'image/png', data: b64(bytes(1)) } }] } }] }),
    );
    expect((await provider.generateImage(imageRequest())).ok).toBe(true);
    expect(calls).toHaveLength(2);
    expect(at(calls[1]?.body, 'generationConfig', 'imageConfig')).toEqual({ aspectRatio: '3:4' });
  });

  it('classifies the per-day free-tier 429 as daily_quota', async () => {
    const { provider } = setup(() => jsonResponse(429, fixtureText('429-per-day-aistudio.json')));
    expect(await provider.generateImage(imageRequest())).toMatchObject({ ok: false, error: { kind: 'daily_quota', retryDelayMs: 41000 } });
  });
});

describe('aistudio video', () => {
  it('submits predictLongRunning with base64 reference images, without generateAudio or sampleCount', async () => {
    const { provider, calls } = setup(() => jsonResponse(200, { name: OPERATION }));
    const result = await provider.submitVideo(videoRequest());

    expect(calls[0]?.url).toBe('https://generativelanguage.googleapis.com/v1beta/models/veo-3.1-generate-preview:predictLongRunning');
    expect(calls[0]?.headers['x-goog-api-key']).toBe(API_KEY);
    expect(calls[0]?.body).toEqual({
      instances: [
        {
          prompt: 'A lamp glows.',
          referenceImages: [{ image: { bytesBase64Encoded: b64(bytes(1, 2)), mimeType: 'image/jpeg' }, referenceType: 'asset' }],
        },
      ],
      parameters: { aspectRatio: '9:16', durationSeconds: 8, resolution: '720p', personGeneration: 'allow_adult', negativePrompt: 'text, watermark' },
    });
    expect(result).toEqual({ ok: true, value: { operationName: OPERATION } });
  });

  it('polls the operation with GET and reports pending', async () => {
    const { provider, calls } = setup(() => jsonResponse(200, { name: OPERATION, done: false }));
    expect(await provider.pollVideo(pollRequest())).toEqual({ ok: true, value: { done: false } });
    expect(calls[0]?.url).toBe(`${AI_STUDIO_BASE_URL}/${OPERATION}`);
    expect(calls[0]?.method).toBe('GET');
    expect(calls[0]?.headers['x-goog-api-key']).toBe(API_KEY);
    expect(calls[0]?.body).toBeUndefined();
  });

  it('downloads the returned file URI with the key as soon as the operation is done', async () => {
    const mp4 = bytes(0, 0, 0, 24, 102, 116, 121, 112);
    const { provider, calls } = setup((call) =>
      call.url === VIDEO_URI
        ? new Response(mp4, { status: 200, headers: { 'content-type': 'video/mp4' } })
        : jsonResponse(200, { name: OPERATION, done: true, response: { generateVideoResponse: { generatedSamples: [{ video: { uri: VIDEO_URI } }] } } }),
    );
    const result = await provider.pollVideo(pollRequest());

    expect(calls).toHaveLength(2);
    expect(calls[1]?.url).toBe(VIDEO_URI);
    expect(calls[1]?.method).toBe('GET');
    expect(calls[1]?.headers['x-goog-api-key']).toBe(API_KEY);
    expect(result).toMatchObject({ ok: true, value: { done: true, video: { mimeType: 'video/mp4' } } });
    if (result.ok && result.value.done) expect([...result.value.video.bytes]).toEqual([...mp4]);
  });

  it('does not send the API key to a non-Google download host', async () => {
    const foreign = 'https://files.example.com/video.mp4';
    const { provider, calls } = setup((call) =>
      call.url === foreign
        ? new Response(bytes(1), { status: 200 })
        : jsonResponse(200, { done: true, response: { generateVideoResponse: { generatedSamples: [{ video: { uri: foreign } }] } } }),
    );
    const result = await provider.pollVideo(pollRequest());
    expect(result.ok).toBe(true);
    expect(calls[1]?.headers['x-goog-api-key']).toBeUndefined();
    if (result.ok && result.value.done) expect(result.value.video.mimeType).toBe('video/mp4');
  });

  it('classifies a failed download (expired file) from its body', async () => {
    const { provider, log } = setup((call) =>
      call.url === VIDEO_URI
        ? jsonResponse(404, { error: { code: 404, message: 'File video-1 not found.', status: 'NOT_FOUND' } })
        : jsonResponse(200, { done: true, response: { generateVideoResponse: { generatedSamples: [{ video: { uri: VIDEO_URI } }] } } }),
    );
    expect(await provider.pollVideo(pollRequest())).toMatchObject({ ok: false, error: { kind: 'invalid_request', httpStatus: 404 } });
    expect(log.lines.some((line) => line.op === 'aistudio.downloadVideo' && line.status === 404)).toBe(true);
  });

  it('maps rai filtered output to safety_blocked and an empty result to no_output', async () => {
    const filtered = setup(() => jsonResponse(200, { done: true, response: { generateVideoResponse: { raiMediaFilteredCount: 1, raiMediaFilteredReasons: ['Support codes: 123'] } } }));
    expect(await filtered.provider.pollVideo(pollRequest())).toMatchObject({ ok: false, error: { kind: 'safety_blocked' } });
    const empty = setup(() => jsonResponse(200, { done: true, response: { generateVideoResponse: {} } }));
    expect(await empty.provider.pollVideo(pollRequest())).toMatchObject({ ok: false, error: { kind: 'no_output' } });
  });

  it('classifies an operation error and a quota 429', async () => {
    const failed = setup(() => jsonResponse(200, { done: true, error: { code: 3, message: "Violates Google's Responsible AI practices. Support codes: 1" } }));
    expect(await failed.provider.pollVideo(pollRequest())).toMatchObject({ ok: false, error: { kind: 'safety_blocked' } });
    const limited = setup(() => jsonResponse(429, fixtureText('429-per-minute-retryinfo.json')));
    expect(await limited.provider.submitVideo(videoRequest())).toMatchObject({ ok: false, error: { kind: 'rate_limited' } });
  });

  it('rejects an operation name that could redirect the request', async () => {
    const { provider, calls } = setup(() => jsonResponse(200, {}));
    expect(await provider.pollVideo(pollRequest('../../evil?x=1'))).toMatchObject({ ok: false, error: { kind: 'invalid_request' } });
    expect(calls).toHaveLength(0);
  });
});

describe('aistudio credentials', () => {
  it('returns auth_error without calling the API when the key is missing', async () => {
    const { provider, calls } = setup(() => jsonResponse(200, {}), { apiKey: undefined });
    expect(await provider.plan(planRequest())).toMatchObject({ ok: false, error: { kind: 'auth_error', providerReason: 'missing_api_key' } });
    expect(await provider.submitVideo(videoRequest())).toMatchObject({ ok: false, error: { kind: 'auth_error' } });
    expect(await provider.pollVideo(pollRequest())).toMatchObject({ ok: false, error: { kind: 'auth_error' } });
    expect(calls).toHaveLength(0);
  });

  it('classifies an invalid key reported as 400 as auth_error', async () => {
    const { provider } = setup(() => jsonResponse(400, fixtureJson('400-api-key-invalid.json')));
    expect(await provider.plan(planRequest())).toMatchObject({ ok: false, error: { kind: 'auth_error' } });
  });
});
