import { describe, expect, it } from 'vitest';
import { defaultGenerationConfig, type BatchConfigSnapshot, type CreativePlan, type GenerationConfig } from '@rs/shared';
import { BACK_VIEW_NOTE, buildFakePlan, buildFallbackPlan, type AiPart, type AiProvider } from '../../src/modules/ai';
import type { BatchItemContext } from '../../src/modules/batches';
import { createImageHandler } from '../../src/modules/generation/image-handler';
import { createRuntime } from '../../src/modules/generation/runtime';
import type { QueueJob } from '../../src/modules/queue';
import { bytes, captureLogger } from '../ai/helpers';

// The image handler, run with stub dependencies (no database): which of a product's image jobs carries the
// mandatory back-view note.

const SHOP = 'demo.myshopify.com';

function snapshotFor(imageCount: number): BatchConfigSnapshot {
  const config: GenerationConfig = defaultGenerationConfig;
  return {
    outputs: { imagesPerProduct: imageCount, videosPerProduct: 0 },
    provider: 'fake',
    models: config.models,
    locations: config.locations,
    image: config.image,
    video: config.video,
    promptVersions: { planner: 'p', image: 'i', video: 'v' },
    promptRefs: { planner: 0, image: 0, video: 0 },
  };
}

function contextFor(imageCount: number, creativePlan: CreativePlan | null): BatchItemContext {
  return {
    shopId: SHOP,
    createdByUserId: 'user-1',
    batchId: 'batch-1',
    itemId: 'item-1',
    productGid: 'gid://shopify/Product/1',
    productSnapshot: {
      title: 'Linen Shirt',
      handle: 'linen-shirt',
      descriptionText: 'A relaxed linen shirt.',
      productType: 'shirt',
      vendor: 'Atelier',
      tags: [],
      options: [],
      featuredImageUrl: 'https://cdn.shopify.com/s/files/1/shirt-front.jpg',
      imageUrls: ['https://cdn.shopify.com/s/files/1/shirt-front.jpg'],
    },
    effectiveReferenceMediaIds: [],
    ownReferenceMediaIds: [],
    references: [],
    referenceMode: 'none',
    styleMode: 'studio',
    creativePlan,
    planSource: creativePlan === null ? null : 'planner',
    config: snapshotFor(imageCount),
    cancelRequested: false,
  };
}

function jobFor(outputIndex: number, error: QueueJob['error'] = null): QueueJob {
  return {
    id: `job-${outputIndex}`,
    shopId: SHOP,
    batchId: 'batch-1',
    batchItemId: 'item-1',
    type: 'image',
    lane: 'fake:image',
    status: 'running',
    dependsOn: [],
    outputIndex,
    priority: 0,
    runAt: new Date(0),
    attempts: 1,
    maxAttempts: 3,
    deferrals: 0,
    operation: null,
    promptVersion: null,
    promptRevision: null,
    renderedPrompt: null,
    output: null,
    error,
    createdAt: new Date(0),
    startedAt: null,
    finishedAt: null,
  };
}

// Runs the image job of every output index and returns the rendered prompt each one sent to the image model.
async function renderedPrompts(imageCount: number, creativePlan: CreativePlan | null, safeRetry = false): Promise<string[]> {
  const ctx = contextFor(imageCount, creativePlan);
  const sent: string[] = [];
  const provider = {
    async generateImage(request: { parts: AiPart[] }) {
      const last = request.parts[request.parts.length - 1];
      sent.push(last?.kind === 'text' ? last.text : '');
      return { ok: true as const, value: { bytes: bytes(1, 2, 3), mimeType: 'image/jpeg', responseId: null, modelVersion: null } };
    },
  } as unknown as AiProvider;

  const runtime = createRuntime({
    ai: { getProvider: () => provider, renderPrompt: () => '' },
    batches: {
      getItemContext: async () => ctx,
      markBatchStarted: async () => undefined,
      markItemPlanning: async () => undefined,
      setCreativePlan: async (_shopId, _itemId, plan, source) => ({ plan, source }),
    },
    media: { storage: { persistOutput: async () => ({ id: 'media-1' }) } } as never,
    getConfig: () => defaultGenerationConfig,
    getPrompt: (name) => ({ name, text: promptTemplate(name), version: 'hash' }) as never,
    logger: captureLogger().logger,
    fetchImpl: async () => new Response(bytes(255, 216, 255), { status: 200, headers: { 'content-type': 'image/jpeg' } }),
  });
  const handler = createImageHandler(runtime);
  const blocked = safeRetry ? { code: 'safety_blocked', message: 'blocked', retryable: true, at: new Date(0) } : null;
  for (let index = 0; index < imageCount; index += 1) {
    const outcome = await handler.run(jobFor(index, blocked as QueueJob['error']), new AbortController().signal);
    expect(outcome.kind).toBe('succeeded');
  }
  return sent;
}

// A short stand-in for the store's image prompt: the real one is not needed to see which notes get appended.
function promptTemplate(name: string): string {
  return name === 'image.user' ? 'Shot: {{shot.prompt}}\nCamera and framing: {{shot.camera}}\nPreserve: {{plan.product.mustPreserve}}' : 'unused';
}

describe('back-view image per product', () => {
  it('adds the back-view note to the last image shot only', async () => {
    const prompts = await renderedPrompts(5, buildFakePlan({ imageCount: 5, videoCount: 0 }));
    expect(prompts).toHaveLength(5);
    prompts.forEach((prompt, index) => {
      expect(prompt.includes(BACK_VIEW_NOTE), `image ${index + 1}`).toBe(index === 4);
    });
  });

  it('uses the second image as the back view when the batch has two images', async () => {
    const prompts = await renderedPrompts(2, buildFakePlan({ imageCount: 2, videoCount: 0 }));
    expect(prompts[0]).not.toContain(BACK_VIEW_NOTE);
    expect(prompts[1]).toContain(BACK_VIEW_NOTE);
  });

  it('leaves a single image as the front hero', async () => {
    const prompts = await renderedPrompts(1, buildFakePlan({ imageCount: 1, videoCount: 0 }));
    expect(prompts[0]).not.toContain(BACK_VIEW_NOTE);
  });

  it('keeps the back view in the safer no-person retry', async () => {
    const prompts = await renderedPrompts(3, buildFakePlan({ imageCount: 3, videoCount: 0 }), true);
    expect(prompts.map((prompt) => prompt.includes(BACK_VIEW_NOTE))).toEqual([false, false, true]);
  });

  it('writes a back-view shot into the fallback plan when no plan exists', async () => {
    // creativePlan null: the handler builds the deterministic fallback plan itself.
    const prompts = await renderedPrompts(3, null);
    expect(prompts[2]).toContain(BACK_VIEW_NOTE);
    expect(prompts[2]).toContain('seen from behind');
    expect(prompts[2]).toContain('back view');
    expect(prompts[0]).not.toContain('seen from behind');
    expect(prompts[0]).toContain('displayed as the hero');
    expect(buildFallbackPlan(contextFor(3, null).productSnapshot, { imageCount: 3, videoCount: 0 }, defaultGenerationConfig).imageShots[2]?.title).toBe('Back view');
  });
});
