import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { batchSummarySchema, type MediaObject } from '@rs/shared';
import { classifyAiError, type AiPart } from '../../src/modules/ai';
import { FAKE_JPEG, FAKE_MP4 } from '../../src/modules/ai/fake-media';
import { BatchItemModel } from '../../src/modules/batches/models';
import { createBatch, defined, login, uploadReadyReferences, type ApiClient, type UploadSpec } from './support/client';
import { MONGO_START_TIMEOUT_MS, startE2e, type E2e } from './support/harness';

const SHOP = 'inputs-store.myshopify.com';

let e2e: E2e;
let client: ApiClient;
let gids: string[] = [];
const refs = new Map<string, MediaObject>();

const withTag = (base: Uint8Array, tag: string): Uint8Array => new Uint8Array([...base, ...Buffer.from(tag)]);
const imageSpec = (tag: string, scope: UploadSpec['scope'], productGid?: string): UploadSpec => ({
  clientId: tag,
  filename: `${tag}.jpg`,
  mimeType: 'image/jpeg',
  bytes: withTag(FAKE_JPEG, tag),
  scope,
  ...(productGid === undefined ? {} : { productGid }),
});
const videoSpec = (tag: string, scope: UploadSpec['scope'], productGid?: string, bytes = withTag(FAKE_MP4, tag)): UploadSpec => ({
  clientId: tag,
  filename: `${tag}.mp4`,
  mimeType: 'video/mp4',
  bytes,
  scope,
  durationSec: 5,
  ...(productGid === undefined ? {} : { productGid }),
});

const ref = (tag: string): MediaObject => defined(refs.get(tag), `reference ${tag}`);
const ids = (...tags: string[]): string[] => tags.map((tag) => ref(tag).id);

// What a part is, in a form a test can compare: product images carry no tag, references carry theirs.
function describePart(part: AiPart): string {
  if (part.kind === 'text') return part.text.startsWith('PRODUCT DATA') ? 'text:PRODUCT DATA' : `text:${part.text.slice(0, 48)}`;
  if (part.kind === 'fileData') return `file:${part.mimeType}:${part.uri}`;
  const base = part.mimeType.startsWith('video/') ? FAKE_MP4 : FAKE_JPEG;
  return `inline:${part.mimeType}:${Buffer.from(part.data.subarray(base.byteLength)).toString() || 'product'}`;
}

beforeAll(async () => {
  e2e = await startE2e({ dbName: 'rs_e2e_inputs' });
  e2e.stub.addShop(SHOP);
  client = await login(e2e, SHOP);
  gids = e2e.stub.shop(SHOP).products.map((product) => product.id);
  const specs = [
    imageSpec('c1', 'common'),
    videoSpec('v1', 'common'),
    imageSpec('c2', 'common'),
    imageSpec('c3', 'common'),
    videoSpec('v2', 'common'),
    videoSpec('v3', 'common'),
    imageSpec('o1', 'product', defined(gids[0])),
    videoSpec('ov1', 'product', defined(gids[0])),
  ];
  const uploaded = await uploadReadyReferences(client, specs);
  specs.forEach((spec, index) => refs.set(spec.clientId, defined(uploaded[index])));
}, MONGO_START_TIMEOUT_MS);

afterAll(async () => {
  await e2e.stop();
});

describe('what the provider receives for a product with own and common references', () => {
  it('follows SPEC 9 and 10 for the planner, the image model and Veo', async () => {
    e2e.editConfig((config) => {
      config.ai.image.maxStyleReferences = 2;
      config.ai.planner.maxReferenceImages = 3;
      config.ai.planner.maxReferenceVideos = 2;
    });
    const provider = e2e.container.ai.getProvider('fake');
    const plan = vi.spyOn(provider, 'plan');
    const image = vi.spyOn(provider, 'generateImage');
    const video = vi.spyOn(provider, 'submitVideo');

    const res = await createBatch(client, {
      products: [{ productGid: defined(gids[0]), referenceMediaIds: ids('o1', 'ov1') }],
      commonReferenceMediaIds: ids('c1', 'v1', 'c2', 'c3', 'v2', 'v3'),
    });
    expect(res.status).toBe(201);
    const batchId = batchSummarySchema.parse(res.body).id;
    expect((await e2e.driveBatch(batchId, { timeoutMs: 60_000 })).status).toBe('completed');
    await e2e.settle();

    const stored = defined(await BatchItemModel.findOne({ batchId }).lean());
    expect(stored.effectiveReferenceMediaIds.map(String)).toEqual(ids('o1', 'ov1', 'c1', 'v1', 'c2', 'c3', 'v2', 'v3'));

    // Planner: product data, 3 product images, the first 3 reference images (own first), the first 2 videos by public url.
    expect(plan).toHaveBeenCalledTimes(1);
    const planned = defined(plan.mock.calls[0]?.[0]);
    expect(planned).toMatchObject({ model: 'gemini-2.5-flash', location: 'us-central1', temperature: 0.6, imageCount: 2, videoCount: 1 });
    expect(planned.systemPrompt).toContain('exactly 2 still image shots and exactly 1 video shots');
    expect(planned.systemPrompt).not.toContain('{{');
    expect(planned.parts.map(describePart)).toEqual([
      'text:PRODUCT DATA',
      'text:PRODUCT IMAGE 1', 'inline:image/jpeg:product',
      'text:PRODUCT IMAGE 2', 'inline:image/jpeg:product',
      'text:PRODUCT IMAGE 3', 'inline:image/jpeg:product',
      'text:STYLE REFERENCE IMAGE 1', 'inline:image/jpeg:o1',
      'text:STYLE REFERENCE IMAGE 2', 'inline:image/jpeg:c1',
      'text:STYLE REFERENCE IMAGE 3', 'inline:image/jpeg:c2',
      'text:STYLE REFERENCE VIDEO 1', `file:video/mp4:${ref('ov1').url}`,
      'text:STYLE REFERENCE VIDEO 2', `file:video/mp4:${ref('v1').url}`,
      'text:Plan exactly 2 image shots and 1 video shots.',
    ]);
    const header = planned.parts[0];
    const facts = JSON.parse((header?.kind === 'text' ? header.text : '').split('\n').slice(1).join('\n')) as Record<string, unknown>;
    expect(facts).toEqual({
      title: 'Ceramic Table Lamp',
      productType: 'Lighting',
      vendor: 'Atelier Nord',
      tags: ['home', 'e2e'],
      options: [{ name: 'Color', values: ['Natural', 'Black'] }],
      description: 'Hand glazed lamp.\nLinen shade',
    });

    // Image model: labelled product images, then the first 2 style references, then the rendered prompt.
    expect(image).toHaveBeenCalledTimes(2);
    for (const [call] of image.mock.calls) {
      expect(call).toMatchObject({ model: 'gemini-2.5-flash-image', location: 'us-central1', aspectRatio: '3:4', imageSize: '2K', outputMimeType: 'image/jpeg' });
      expect(call.parts.slice(0, -1).map(describePart)).toEqual([
        'text:PRODUCT IMAGE 1', 'inline:image/jpeg:product',
        'text:PRODUCT IMAGE 2', 'inline:image/jpeg:product',
        'text:PRODUCT IMAGE 3', 'inline:image/jpeg:product',
        'text:STYLE REFERENCE 1', 'inline:image/jpeg:o1',
        'text:STYLE REFERENCE 2', 'inline:image/jpeg:c1',
      ]);
      const prompt = call.parts[call.parts.length - 1];
      const text = prompt?.kind === 'text' ? prompt.text : '';
      expect(text).toContain('Create one photorealistic lifestyle photograph');
      expect(text).toContain('3:4 aspect ratio');
      expect(text).toContain('Preserve: exact shape, colors, materials, printed text and logos as in the product images');
      expect(text).not.toContain('{{');
    }

    // Veo: reference-image mode with three product images and the configured parameters.
    expect(video).toHaveBeenCalledTimes(1);
    const submitted = defined(video.mock.calls[0]?.[0]);
    expect(submitted).toMatchObject({
      model: 'veo-3.1-generate-001',
      durationSeconds: 8,
      aspectRatio: '9:16',
      resolution: '720p',
      generateAudio: false,
      personGeneration: 'allow_adult',
      sampleCount: 1,
      negativePrompt: e2e.config.get().video.negativePrompt,
    });
    expect(submitted.startImage).toBeUndefined();
    expect(submitted.referenceImages).toHaveLength(3);
    expect(submitted.prompt).toContain('Camera: slow push-in toward the product');
    expect(submitted.prompt).not.toContain('{{');

    // Product images come from the resized CDN urls, the featured one first, at most 3 per call.
    const cdn = e2e.stub.state.calls.flatMap((call) => (call.kind === 'cdn' && call.url.includes('/products/') ? [call.url] : []));
    expect(cdn.every((url) => url.includes('width=1536'))).toBe(true);
    const fetched = (suffix: string): number => cdn.filter((url) => url.includes(suffix)).length;
    expect([1, 2, 3].map((n) => fetched(`ceramic-table-lamp-${n}.jpg`))).toEqual([4, 4, 4]);
    expect([4, 5, 6].map((n) => fetched(`ceramic-table-lamp-${n}.jpg`))).toEqual([0, 0, 0]);
    // Reference images are downloaded by the planner (3) and the image jobs (2 each); videos only by url.
    const refFetches = (tag: string): number =>
      e2e.stub.state.calls.filter((call) => call.kind === 'cdn' && call.url.startsWith(defined(ref(tag).url).split('?')[0] ?? '')).length;
    expect(['o1', 'c1', 'c2', 'c3'].map(refFetches)).toEqual([3, 3, 1, 0]);
    expect(['ov1', 'v1', 'v2', 'v3'].map(refFetches)).toEqual([0, 0, 0, 0]);
    vi.restoreAllMocks();
  }, 90_000);

  it('still works when every reference is a video: the image model gets the product images only', async () => {
    const provider = e2e.container.ai.getProvider('fake');
    const plan = vi.spyOn(provider, 'plan');
    const image = vi.spyOn(provider, 'generateImage');
    const res = await createBatch(client, { products: [{ productGid: defined(gids[2]) }], commonReferenceMediaIds: ids('v1', 'v2') });
    const batchId = batchSummarySchema.parse(res.body).id;
    expect((await e2e.driveBatch(batchId, { timeoutMs: 60_000 })).status).toBe('completed');
    await e2e.settle();

    const planned = defined(plan.mock.calls[0]?.[0]).parts.map(describePart);
    expect(planned.filter((part) => part.startsWith('file:'))).toEqual([`file:video/mp4:${ref('v1').url}`, `file:video/mp4:${ref('v2').url}`]);
    expect(planned.some((part) => part.includes('STYLE REFERENCE IMAGE'))).toBe(false);
    for (const [call] of image.mock.calls) {
      expect(call.parts.slice(0, -1).map(describePart).filter((part) => part.includes('STYLE REFERENCE'))).toEqual([]);
      expect(call.parts.filter((part) => part.kind === 'inlineData')).toHaveLength(3);
    }
    vi.restoreAllMocks();
  }, 90_000);

  it('sends reference videos inline when the provider rejects their urls, and skips the ones over 20 MB', async () => {
    const big = videoSpec('big', 'common', undefined, new Uint8Array(21 * 1024 * 1024));
    const [bigVideo] = await uploadReadyReferences(client, [big]);
    const plan = vi.spyOn(e2e.container.ai.getProvider('fake'), 'plan');
    plan.mockImplementationOnce(async () => ({ ok: false, error: classifyAiError(400, fixture('400-invalid-argument.json')) }));

    const res = await createBatch(client, {
      products: [{ productGid: defined(gids[1]) }],
      commonReferenceMediaIds: [defined(bigVideo).id, ref('v1').id, ref('c1').id],
    });
    const batchId = batchSummarySchema.parse(res.body).id;
    expect((await e2e.driveBatch(batchId, { timeoutMs: 60_000 })).status).toBe('completed');
    await e2e.settle();

    expect(plan).toHaveBeenCalledTimes(2);
    const [first, retry] = plan.mock.calls.map(([call]) => call.parts.map(describePart));
    expect(first?.filter((part) => part.startsWith('file:'))).toEqual([`file:video/mp4:${defined(bigVideo).url}`, `file:video/mp4:${ref('v1').url}`]);
    expect(retry?.filter((part) => part.startsWith('file:'))).toEqual([]);
    expect(retry?.filter((part) => part.startsWith('inline:video/mp4'))).toEqual(['inline:video/mp4:v1']);

    const stored = defined(await BatchItemModel.findOne({ batchId }).lean());
    expect(stored.planSource).toBe('planner');
    expect(stored.creativePlan?.warnings).toHaveLength(1);
    expect(stored.creativePlan?.warnings[0]).toMatch(/Reference video "rs-ref-[0-9a-f]{8}\.mp4" was skipped: the provider rejected its url and it is larger than 20 MB/);
    vi.restoreAllMocks();
  }, 90_000);
});

function fixture(name: string): string {
  return readFileSync(new URL(`../../fixtures/ai-errors/${name}`, import.meta.url), 'utf8');
}
