import { randomUUID } from 'node:crypto';
import type { CreativePlan, GenerationConfig, ImageShot, PlanCounts, VideoShot } from '@rs/shared';
import type { Logger } from '../../core/logger';
import type { AiPart, AiProvider, AiResult, ClassifiedError } from './index';
import { classifyAiError, classifyTransportError } from './errors';
import { FAKE_JPEG, FAKE_MP4 } from './fake-media';

// Fake provider for development and tests: no network, no credits. Latency and the share of simulated
// 429s come from the live config (fake.latencyMs, fake.rateLimitProbability).

export interface FakeDeps {
  logger: Logger;
  getConfig: () => GenerationConfig;
  // Test hooks.
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  random?: () => number;
}

// Submit and poll calls are quick on real providers; the configured latency applies to plan and image.
const QUICK_CALL_MAX_MS = 500;

function defaultSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason);
      return;
    }
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

const SHOT_PROMPT =
  'A calm, premium lifestyle scene built around the featured product, placed at the center of a sunlit, ' +
  'minimal room with a pale wooden surface, a softly blurred window in the background and a few neutral, ' +
  'unbranded props at a respectful distance. Soft natural daylight arrives from the left and wraps the ' +
  'product with gentle shading and a believable contact shadow. The camera sits at eye level with a ' +
  '50mm lens and a shallow depth of field, keeping the product sharp, fully visible and at realistic ' +
  'scale. The palette is warm and neutral, the mood quiet, aspirational and commercially clean.';

function fakeImageShot(index: number): ImageShot {
  return {
    shotId: `fake-image-${index + 1}`,
    title: `Fake image shot ${index + 1}`,
    scene: 'Sunlit minimal room with a pale wooden surface',
    camera: 'Eye level, 50mm lens, shallow depth of field',
    lighting: 'Soft natural daylight from the left',
    people: 'none',
    prompt: SHOT_PROMPT,
    negative: 'text, watermark, distorted product',
  };
}

function fakeVideoShot(index: number): VideoShot {
  return {
    ...fakeImageShot(index),
    shotId: `fake-video-${index + 1}`,
    title: `Fake video shot ${index + 1}`,
    cameraMove: 'slow push-in toward the product',
    subjectAction: 'none, the product stays still',
  };
}

// Deterministic and schema-valid for any counts.
export function buildFakePlan(counts: PlanCounts): CreativePlan {
  return {
    product: {
      category: 'fake product',
      keyAttributes: ['simple shape', 'neutral color', 'matte finish'],
      mustPreserve: ['exact shape, colors, materials, printed text and logos as in the product images'],
      scaleHint: 'handheld size',
    },
    referenceStyle: {
      setting: 'sunlit minimal room',
      lighting: 'soft natural daylight',
      palette: 'warm neutral',
      mood: 'calm and premium',
      composition: 'product centered as the hero',
      motion: 'slow push-in',
    },
    imageShots: Array.from({ length: counts.imageCount }, (_unused, index) => fakeImageShot(index)),
    videoShots: Array.from({ length: counts.videoCount }, (_unused, index) => fakeVideoShot(index)),
    warnings: [],
  };
}

// A realistic per-minute Gemini API 429 body, so the simulated error goes through the real classifier.
const SIMULATED_RATE_LIMIT_BODY = JSON.stringify({
  error: {
    code: 429,
    message:
      'You exceeded your current quota (simulated by the fake provider). Quota exceeded for metric: fake_requests_per_minute. Please retry in 5s.',
    status: 'RESOURCE_EXHAUSTED',
    details: [
      {
        '@type': 'type.googleapis.com/google.rpc.QuotaFailure',
        violations: [
          {
            quotaMetric: 'fake.googleapis.com/generate_content_requests',
            quotaId: 'FakeRequestsPerMinutePerProjectPerModel',
            quotaValue: '60',
          },
        ],
      },
      { '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay: '5s' },
    ],
  },
});

function firstInlineImage(parts: AiPart[]): { bytes: Uint8Array; mimeType: string } | null {
  for (const part of parts) {
    if (part.kind === 'inlineData' && part.mimeType.startsWith('image/')) {
      return { bytes: new Uint8Array(part.data), mimeType: part.mimeType };
    }
  }
  return null;
}

export function createFakeProvider(deps: FakeDeps): AiProvider {
  const sleep = deps.sleep ?? defaultSleep;
  const random = deps.random ?? Math.random;
  // Poll counts per operation. A video completes on its second poll.
  const polls = new Map<string, number>();

  async function simulate<T>(signal: AbortSignal, quick: boolean, produce: () => T): Promise<AiResult<T>> {
    const { fake } = deps.getConfig();
    if (random() < fake.rateLimitProbability) {
      deps.logger.debug('fake provider simulating a 429');
      const error: ClassifiedError = classifyAiError(429, SIMULATED_RATE_LIMIT_BODY);
      return { ok: false, error };
    }
    try {
      await sleep(quick ? Math.min(fake.latencyMs, QUICK_CALL_MAX_MS) : fake.latencyMs, signal);
    } catch (err) {
      return { ok: false, error: classifyTransportError(err, signal) };
    }
    return { ok: true, value: produce() };
  }

  return {
    name: 'fake',

    plan: (request) =>
      simulate(request.signal, false, () => {
        const plan = buildFakePlan({ imageCount: request.imageCount, videoCount: request.videoCount });
        return { json: plan, rawText: JSON.stringify(plan), responseId: `fake-plan-${randomUUID()}`, modelVersion: 'fake-planner' };
      }),

    generateImage: (request) =>
      simulate(request.signal, false, () => {
        const echoed = firstInlineImage(request.parts);
        return {
          bytes: echoed?.bytes ?? new Uint8Array(FAKE_JPEG),
          mimeType: echoed?.mimeType ?? 'image/jpeg',
          responseId: `fake-image-${randomUUID()}`,
          modelVersion: 'fake-image',
        };
      }),

    submitVideo: (request) =>
      simulate(request.signal, true, () => {
        const operationName = `fake/operations/${randomUUID()}`;
        polls.set(operationName, 0);
        return { operationName };
      }),

    pollVideo: (request) =>
      simulate(request.signal, true, () => {
        const count = (polls.get(request.operationName) ?? 0) + 1;
        if (count < 2) {
          polls.set(request.operationName, count);
          return { done: false as const };
        }
        polls.delete(request.operationName);
        return { done: true as const, video: { bytes: new Uint8Array(FAKE_MP4), mimeType: 'video/mp4' }, modelVersion: 'fake-video' };
      }),
  };
}
