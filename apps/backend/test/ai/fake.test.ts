import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createCreativePlanSchema, defaultGenerationConfig, type GenerationConfig } from '@rs/shared';
import { createAiModule } from '../../src/modules/ai';
import type { ImageRequest, PlanRequest, VideoPollRequest, VideoSubmitRequest } from '../../src/modules/ai';
import { createFakeProvider } from '../../src/modules/ai/fake';
import { FAKE_JPEG, FAKE_MP4 } from '../../src/modules/ai/fake-media';
import { bytes, captureLogger, signal } from './helpers';

function configWith(fake: Partial<GenerationConfig['fake']>): GenerationConfig {
  return { ...defaultGenerationConfig, fake: { ...defaultGenerationConfig.fake, ...fake } };
}

function create(config: GenerationConfig, random: () => number = () => 0.99) {
  const sleeps: number[] = [];
  const provider = createFakeProvider({
    logger: captureLogger().logger,
    getConfig: () => config,
    sleep: async (ms) => void sleeps.push(ms),
    random,
  });
  return { provider, sleeps };
}

const planRequest = (imageCount = 2, videoCount = 1): PlanRequest => ({
  model: 'fake-planner',
  location: 'us-central1',
  signal: signal(),
  systemPrompt: 's',
  parts: [{ kind: 'text', text: 'x' }],
  imageCount,
  videoCount,
  temperature: 0.6,
});

const imageRequest = (parts: ImageRequest['parts']): ImageRequest => ({
  model: 'fake-image',
  location: 'us-central1',
  signal: signal(),
  parts,
  aspectRatio: '3:4',
  imageSize: '2K',
  outputMimeType: 'image/jpeg',
});

const videoRequest = (): VideoSubmitRequest => ({
  model: 'fake-video',
  location: 'us-central1',
  signal: signal(),
  prompt: 'p',
  negativePrompt: '',
  referenceImages: [],
  durationSeconds: 8,
  aspectRatio: '9:16',
  resolution: '720p',
  generateAudio: false,
  personGeneration: 'allow_adult',
  sampleCount: 1,
});

const pollRequest = (operationName: string): VideoPollRequest => ({ model: 'fake-video', location: 'us-central1', signal: signal(), operationName });

describe('fake provider', () => {
  it('is named fake and applies the configured latency to plan and image calls', async () => {
    const { provider, sleeps } = create(configWith({ latencyMs: 1234 }));
    expect(provider.name).toBe('fake');
    await provider.plan(planRequest());
    await provider.generateImage(imageRequest([{ kind: 'text', text: 'p' }]));
    expect(sleeps).toEqual([1234, 1234]);
  });

  it('keeps submit and poll calls quick even with a long latency', async () => {
    const { provider, sleeps } = create(configWith({ latencyMs: 10_000 }));
    const submitted = await provider.submitVideo(videoRequest());
    if (!submitted.ok) throw new Error('submit failed');
    await provider.pollVideo(pollRequest(submitted.value.operationName));
    expect(Math.max(...sleeps)).toBeLessThanOrEqual(500);
  });

  it('returns a deterministic plan that validates for the requested counts', async () => {
    const { provider } = create(configWith({ latencyMs: 0 }));
    for (const counts of [{ imageCount: 2, videoCount: 1 }, { imageCount: 0, videoCount: 0 }, { imageCount: 6, videoCount: 2 }]) {
      const result = await provider.plan(planRequest(counts.imageCount, counts.videoCount));
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(createCreativePlanSchema(counts).safeParse(result.value.json).success).toBe(true);
      expect(JSON.parse(result.value.rawText)).toEqual(result.value.json);
    }
    const a = await provider.plan(planRequest());
    const b = await provider.plan(planRequest());
    expect(a.ok && b.ok && a.value.json).toEqual(b.ok && b.value.json);
  });

  it('echoes the first inline image of the request', async () => {
    const { provider } = create(configWith({ latencyMs: 0 }));
    const result = await provider.generateImage(
      imageRequest([
        { kind: 'text', text: 'PRODUCT IMAGE 1' },
        { kind: 'inlineData', mimeType: 'image/webp', data: bytes(7, 7, 7) },
        { kind: 'inlineData', mimeType: 'image/png', data: bytes(9) },
        { kind: 'text', text: 'prompt' },
      ]),
    );
    expect(result).toMatchObject({ ok: true, value: { mimeType: 'image/webp' } });
    if (result.ok) expect([...result.value.bytes]).toEqual([7, 7, 7]);
  });

  it('returns a tiny valid JPEG when the request has no input image', async () => {
    const { provider } = create(configWith({ latencyMs: 0 }));
    const result = await provider.generateImage(imageRequest([{ kind: 'text', text: 'prompt' }]));
    expect(result.ok && result.value.mimeType).toBe('image/jpeg');
    if (result.ok) {
      expect([...result.value.bytes]).toEqual([...FAKE_JPEG]);
      expect(result.value.bytes.length).toBeLessThan(1024);
      expect([result.value.bytes[0], result.value.bytes[1]]).toEqual([0xff, 0xd8]);
      expect([result.value.bytes.at(-2), result.value.bytes.at(-1)]).toEqual([0xff, 0xd9]);
    }
  });

  it('does not echo non-image inline data', async () => {
    const { provider } = create(configWith({ latencyMs: 0 }));
    const result = await provider.generateImage(imageRequest([{ kind: 'inlineData', mimeType: 'video/mp4', data: bytes(1) }]));
    expect(result.ok && result.value.mimeType).toBe('image/jpeg');
  });

  it('completes a video on the second poll with MP4 stub bytes', async () => {
    const { provider } = create(configWith({ latencyMs: 0 }));
    const submitted = await provider.submitVideo(videoRequest());
    expect(submitted.ok).toBe(true);
    if (!submitted.ok) return;
    const { operationName } = submitted.value;
    expect(operationName).toMatch(/^fake\/operations\//);

    expect(await provider.pollVideo(pollRequest(operationName))).toEqual({ ok: true, value: { done: false } });
    const second = await provider.pollVideo(pollRequest(operationName));
    expect(second).toMatchObject({ ok: true, value: { done: true, video: { mimeType: 'video/mp4' } } });
    if (second.ok && second.value.done) {
      expect([...second.value.video.bytes]).toEqual([...FAKE_MP4]);
      expect(String.fromCharCode(...second.value.video.bytes.slice(4, 8))).toBe('ftyp');
    }
  });

  it('tracks operations independently', async () => {
    const { provider } = create(configWith({ latencyMs: 0 }));
    const one = await provider.submitVideo(videoRequest());
    const two = await provider.submitVideo(videoRequest());
    if (!one.ok || !two.ok) throw new Error('submit failed');
    expect(one.value.operationName).not.toBe(two.value.operationName);
    await provider.pollVideo(pollRequest(one.value.operationName));
    expect(await provider.pollVideo(pollRequest(two.value.operationName))).toEqual({ ok: true, value: { done: false } });
    expect(await provider.pollVideo(pollRequest(one.value.operationName))).toMatchObject({ ok: true, value: { done: true } });
  });

  it('simulates realistic 429s at the configured probability, classified rate_limited', async () => {
    const { provider } = create(configWith({ latencyMs: 0, rateLimitProbability: 1 }), () => 0.5);
    const results = [
      await provider.plan(planRequest()),
      await provider.generateImage(imageRequest([{ kind: 'text', text: 'p' }])),
      await provider.submitVideo(videoRequest()),
      await provider.pollVideo(pollRequest('x')),
    ];
    for (const result of results) {
      expect(result).toMatchObject({
        ok: false,
        error: { kind: 'rate_limited', httpStatus: 429, providerStatus: 'RESOURCE_EXHAUSTED', retryDelayMs: 5000, retryable: true },
      });
      if (!result.ok) expect(JSON.parse(result.error.rawBody ?? '{}')).toMatchObject({ error: { code: 429, status: 'RESOURCE_EXHAUSTED' } });
    }
  });

  it('only rate limits when the random draw falls under the probability', async () => {
    const draws = [0.1, 0.5];
    const { provider } = create(configWith({ latencyMs: 0, rateLimitProbability: 0.3 }), () => draws.shift() ?? 0.99);
    expect((await provider.plan(planRequest())).ok).toBe(false);
    expect((await provider.plan(planRequest())).ok).toBe(true);
  });

  it('reads latency and probability from the live config on every call', async () => {
    let config = configWith({ latencyMs: 10 });
    const sleeps: number[] = [];
    const provider = createFakeProvider({ logger: captureLogger().logger, getConfig: () => config, sleep: async (ms) => void sleeps.push(ms), random: () => 0.5 });
    await provider.plan(planRequest());
    config = configWith({ latencyMs: 20, rateLimitProbability: 1 });
    expect((await provider.plan(planRequest())).ok).toBe(false);
    config = configWith({ latencyMs: 30 });
    await provider.plan(planRequest());
    expect(sleeps).toEqual([10, 30]);
  });

  it('maps an abort during the simulated latency to transient timeout', async () => {
    const provider = createFakeProvider({ logger: captureLogger().logger, getConfig: () => configWith({ latencyMs: 60_000 }) });
    const controller = new AbortController();
    const pending = provider.plan({ ...planRequest(), signal: controller.signal });
    controller.abort(new DOMException('timed out', 'TimeoutError'));
    expect(await pending).toMatchObject({ ok: false, error: { kind: 'transient', providerReason: 'timeout' } });
  });
});

describe('createAiModule', () => {
  const env = { GOOGLE_CLOUD_PROJECT: 'p', GEMINI_API_KEY: 'k' };
  const base = { env, logger: captureLogger().logger, getConfig: () => defaultGenerationConfig };

  it('returns a provider per name and memoizes it', () => {
    const ai = createAiModule(base);
    for (const name of ['vertex', 'aistudio', 'fake'] as const) {
      expect(ai.getProvider(name).name).toBe(name);
      expect(ai.getProvider(name)).toBe(ai.getProvider(name));
    }
  });

  it('exposes renderPrompt with throw-on-unknown semantics', () => {
    const ai = createAiModule(base);
    expect(ai.renderPrompt('Hi {{name}}', { name: 'there' })).toBe('Hi there');
    expect(() => ai.renderPrompt('Hi {{nope}}', {})).toThrow();
  });

  it('wires the injected fetch and token source into the vertex provider', async () => {
    const urls: string[] = [];
    const ai = createAiModule({
      ...base,
      getAccessToken: async () => 'tok',
      fetchImpl: async (input) => {
        urls.push(String(input));
        return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: '{}' }] } }] }), { status: 200 });
      },
    });
    await ai.getProvider('vertex').plan({ ...planRequest(), location: 'global' });
    expect(urls).toEqual([
      'https://aiplatform.googleapis.com/v1/projects/p/locations/global/publishers/google/models/fake-planner:generateContent',
    ]);
  });

  it('maps a google-auth-library credentials failure to auth_error without any network call', async () => {
    const previous = process.env.GOOGLE_APPLICATION_CREDENTIALS;
    process.env.GOOGLE_APPLICATION_CREDENTIALS = join(tmpdir(), 'rs-no-such-credentials.json');
    try {
      let fetched = false;
      const ai = createAiModule({ ...base, fetchImpl: async () => { fetched = true; return new Response('{}'); } });
      const result = await ai.getProvider('vertex').plan(planRequest());
      expect(result).toMatchObject({ ok: false, error: { kind: 'auth_error', providerReason: 'token_error' } });
      expect(fetched).toBe(false);
    } finally {
      if (previous === undefined) delete process.env.GOOGLE_APPLICATION_CREDENTIALS;
      else process.env.GOOGLE_APPLICATION_CREDENTIALS = previous;
    }
  });

  it('reports missing credentials as auth_error instead of throwing', async () => {
    const ai = createAiModule({ ...base, env: {}, getAccessToken: async () => 'tok', fetchImpl: async () => new Response('{}') });
    expect(await ai.getProvider('aistudio').plan(planRequest())).toMatchObject({ ok: false, error: { kind: 'auth_error' } });
    expect(await ai.getProvider('vertex').plan(planRequest())).toMatchObject({ ok: false, error: { kind: 'auth_error' } });
  });
});
