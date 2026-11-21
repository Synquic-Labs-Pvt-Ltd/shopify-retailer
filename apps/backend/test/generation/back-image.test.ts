import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { defaultGenerationConfig, type BatchConfigSnapshot, type CreativePlan, type GenerationConfig } from '@rs/shared';
import { BACK_VIEW_NOTE, CHILD_MODEL_NOTE, SAFE_IMAGE_NOTE, buildFakePlan, buildFallbackPlan, type AiPart, type AiProvider } from '../../src/modules/ai';
import type { BatchItemContext } from '../../src/modules/batches';
import { createImageHandler } from '../../src/modules/generation/image-handler';
import { createRuntime } from '../../src/modules/generation/runtime';
import type { QueueJob } from '../../src/modules/queue';
import { bytes, captureLogger } from '../ai/helpers';

// The image handler, run with stub dependencies (no database): which of a product's image jobs carries the
// mandatory back-view note.

const SHOP = 'demo.myshopify.com';

// What the stub model returns (the bytes and the type it labels them with), and what was handed to storage.
const PNG_HEADER = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, 0, 0, 0x07, 0x00, 0, 0, 0x09, 0x60, 8, 6, 0, 0, 0]);
let modelReturns: { bytes: Uint8Array; mimeType: string } | null = null;
const stored: Array<{ mimeType: string; filename: string }> = [];

// The header of an 864x1184 progressive JPEG (the size the model in use returns today), enough for its size to be read.
const GENERATED_JPEG = Uint8Array.from([0xff, 0xd8, 0xff, 0xc2, 0, 17, 8, 0x04, 0xa0, 0x03, 0x60, 3, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1, 0xff, 0xd9]);

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

function contextFor(imageCount: number, creativePlan: CreativePlan | null, title = 'Linen Shirt'): BatchItemContext {
  return {
    shopId: SHOP,
    createdByUserId: 'user-1',
    batchId: 'batch-1',
    itemId: 'item-1',
    productGid: 'gid://shopify/Product/1',
    productSnapshot: {
      title,
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
async function renderedPrompts(
  imageCount: number,
  creativePlan: CreativePlan | null,
  safeRetry = false,
  title = 'Linen Shirt',
  logLines?: Record<string, unknown>[],
): Promise<string[]> {
  const ctx = contextFor(imageCount, creativePlan, title);
  const capture = captureLogger();
  const sent: string[] = [];
  const provider = {
    async generateImage(request: { parts: AiPart[] }) {
      const last = request.parts[request.parts.length - 1];
      sent.push(last?.kind === 'text' ? last.text : '');
      const returned = modelReturns ?? { bytes: GENERATED_JPEG, mimeType: 'image/jpeg' };
      return { ok: true as const, value: { ...returned, responseId: null, modelVersion: null } };
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
    media: {
      storage: {
        persistOutput: async (input: { mimeType: string; filename: string }) => {
          stored.push({ mimeType: input.mimeType, filename: input.filename });
          return { id: 'media-1' };
        },
      },
    } as never,
    getConfig: () => defaultGenerationConfig,
    getPrompt: (name) => ({ name, text: promptTemplate(name), version: 'hash' }) as never,
    logger: capture.logger,
    fetchImpl: async () => new Response(bytes(255, 216, 255), { status: 200, headers: { 'content-type': 'image/jpeg' } }),
  });
  const handler = createImageHandler(runtime);
  const blocked = safeRetry ? { code: 'safety_blocked', message: 'blocked', retryable: true, at: new Date(0) } : null;
  for (let index = 0; index < imageCount; index += 1) {
    const outcome = await handler.run(jobFor(index, blocked as QueueJob['error']), new AbortController().signal);
    expect(outcome.kind).toBe('succeeded');
  }
  logLines?.push(...capture.lines);
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

// Who appears in a shot: a child model for children's everyday wear, a mannequin for intimate wear and swimwear.
describe('child model and mannequin-only products', () => {
  const planWithPeople = (people: string): CreativePlan => {
    const base = buildFakePlan({ imageCount: 3, videoCount: 0 });
    return { ...base, imageShots: base.imageShots.map((shot) => ({ ...shot, people })) };
  };

  it("renders a child model's shots normally for a kids' dress", async () => {
    const prompts = await renderedPrompts(3, planWithPeople('child model, about 6 to 8 years old'), false, 'Pink Velvet Dress');
    for (const prompt of prompts) {
      expect(prompt).toContain(CHILD_MODEL_NOTE);
      expect(prompt).not.toContain(SAFE_IMAGE_NOTE);
    }
  });

  it('shows swimwear on no person from the very first attempt, whatever the plan says', async () => {
    // The plan wrongly asks for a child model; the product data wins.
    const prompts = await renderedPrompts(3, planWithPeople('child model, about 6 to 8 years old'), false, 'Girls Floral Swimsuit');
    for (const prompt of prompts) {
      expect(prompt.endsWith(SAFE_IMAGE_NOTE)).toBe(true);
      expect(prompt).not.toContain(CHILD_MODEL_NOTE);
    }
    expect(prompts[2]).toContain(BACK_VIEW_NOTE);
  });

  it('keeps an adult-model shot untouched for an ordinary product', async () => {
    const prompts = await renderedPrompts(2, planWithPeople('adult model'), false, 'Linen Shirt');
    for (const prompt of prompts) {
      expect(prompt).not.toContain(CHILD_MODEL_NOTE);
      expect(prompt).not.toContain(SAFE_IMAGE_NOTE);
    }
  });
});

describe('what the model returned is logged', () => {
  it('logs the format, the pixel size and the requested options of every generated image', async () => {
    const lines: Record<string, unknown>[] = [];
    await renderedPrompts(2, buildFakePlan({ imageCount: 2, videoCount: 0 }), false, 'Linen Shirt', lines);
    const generated = lines.filter((line) => line.msg === 'image generated');
    expect(generated).toHaveLength(2);
    expect(generated[0]).toMatchObject({
      mimeType: 'image/jpeg',
      width: 864,
      height: 1184,
      bytes: GENERATED_JPEG.byteLength,
      requestedSize: defaultGenerationConfig.image.imageSize,
      requestedMimeType: defaultGenerationConfig.image.outputMimeType,
    });
  });
});

describe('the stored type follows the bytes, not the label', () => {
  beforeEach(() => {
    stored.length = 0;
  });

  afterEach(() => {
    modelReturns = null;
    stored.length = 0;
  });

  it('stores a JPEG that the model labeled image/png as a .jpg, and says so in the log', async () => {
    modelReturns = { bytes: GENERATED_JPEG, mimeType: 'image/png' };
    const lines: Record<string, unknown>[] = [];
    await renderedPrompts(1, buildFakePlan({ imageCount: 1, videoCount: 0 }), false, 'Linen Shirt', lines);
    expect(stored).toHaveLength(1);
    expect(stored[0]?.mimeType).toBe('image/jpeg');
    expect(stored[0]?.filename.endsWith('.jpg')).toBe(true);
    expect(lines.some((line) => line.msg === 'the model labeled the image with the wrong type: storing it under its real type')).toBe(true);
    expect(lines.find((line) => line.msg === 'image generated')).toMatchObject({ mimeType: 'image/jpeg', declaredMimeType: 'image/png', width: 864, height: 1184 });
  });

  it('stores a real PNG as a .png, and keeps the type of bytes it cannot identify', async () => {
    modelReturns = { bytes: PNG_HEADER, mimeType: 'image/png' };
    const lines: Record<string, unknown>[] = [];
    await renderedPrompts(1, buildFakePlan({ imageCount: 1, videoCount: 0 }), false, 'Linen Shirt', lines);
    expect(stored[0]?.mimeType).toBe('image/png');
    expect(stored[0]?.filename.endsWith('.png')).toBe(true);
    expect(lines.some((line) => String(line.msg).includes('wrong type'))).toBe(false);

    stored.length = 0;
    modelReturns = { bytes: Uint8Array.from([1, 2, 3, 4]), mimeType: 'image/webp' };
    await renderedPrompts(1, buildFakePlan({ imageCount: 1, videoCount: 0 }));
    expect(stored[0]?.mimeType).toBe('image/webp');
    expect(stored[0]?.filename.endsWith('.webp')).toBe(true);
  });
});
