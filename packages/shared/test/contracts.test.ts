import { describe, expect, it } from 'vitest';
import {
  ERROR_CODES,
  ERROR_HTTP_STATUS,
  authExchangeRequestSchema,
  createBatchRequestSchema,
  createCreativePlanSchema,
  creativePlanSchema,
  defaultGenerationConfig,
  errorEnvelopeSchema,
  generationConfigSchema,
  isTerminalBatchStatus,
  mediaListQuerySchema,
  normalizeShopDomain,
  paginationQuerySchema,
  productListQuerySchema,
  resolveLaneConfig,
  shopDomainSchema,
  uploadFileRequestSchema,
} from '../src';

const id = (n: number): string => n.toString(16).padStart(24, '0');
const gid = (n: number): string => `gid://shopify/Product/${n}`;

const shot = {
  shotId: 'img-1',
  title: 'Hero on a shelf',
  scene: 'A sunlit shelf',
  camera: 'Eye level, 50mm',
  lighting: 'Soft window light',
  people: 'none',
  prompt: 'A short fallback style prompt.',
  negative: 'text, watermark',
};

const plan = {
  product: { category: 'ceramic table lamp', keyAttributes: ['ceramic'], mustPreserve: ['exact shape'], scaleHint: '40 cm tall' },
  referenceStyle: { setting: '', lighting: '', palette: '', mood: '', composition: '', motion: '' },
  imageShots: [shot, { ...shot, shotId: 'img-2' }],
  videoShots: [{ ...shot, shotId: 'vid-1', cameraMove: 'slow push-in', subjectAction: 'none' }],
  warnings: [],
};

describe('generation config', () => {
  it('accepts the default config', () => {
    expect(generationConfigSchema.parse(defaultGenerationConfig)).toEqual(defaultGenerationConfig);
  });

  it('rejects unknown keys and bad values', () => {
    expect(generationConfigSchema.safeParse({ ...defaultGenerationConfig, extra: 1 }).success).toBe(false);
    expect(generationConfigSchema.safeParse({ ...defaultGenerationConfig, outputs: { imagesPerProduct: 7, videosPerProduct: 1 } }).success).toBe(false);
    expect(generationConfigSchema.safeParse({ ...defaultGenerationConfig, video: { ...defaultGenerationConfig.video, durationSeconds: 6 } }).success).toBe(false);
  });

  it('rejects a lane that points at an unknown poll lane', () => {
    const lanes = {
      ...defaultGenerationConfig.lanes,
      'vertex:veo-3.1-generate-001': { ...defaultGenerationConfig.lanes['vertex:veo-3.1-generate-001']!, pollLane: 'vertex:missing' },
    };
    expect(generationConfigSchema.safeParse({ ...defaultGenerationConfig, lanes }).success).toBe(false);
  });

  it('resolves exact lanes first and provider wildcards second', () => {
    expect(resolveLaneConfig(defaultGenerationConfig.lanes, 'vertex:poll')?.rpm).toBe(60);
    expect(resolveLaneConfig(defaultGenerationConfig.lanes, 'fake:anything')?.maxConcurrent).toBe(4);
    expect(resolveLaneConfig(defaultGenerationConfig.lanes, 'aistudio:gemini-2.5-flash')).toBeUndefined();
  });
});

describe('creative plan', () => {
  it('accepts a short fallback-style plan', () => {
    expect(creativePlanSchema.safeParse(plan).success).toBe(true);
  });

  it('enforces exact shot counts and the title limit', () => {
    expect(createCreativePlanSchema({ imageCount: 2, videoCount: 1 }).safeParse(plan).success).toBe(true);
    expect(createCreativePlanSchema({ imageCount: 3, videoCount: 1 }).safeParse(plan).success).toBe(false);
    const longTitle = { ...plan, imageShots: [{ ...shot, title: 'x'.repeat(61) }] };
    expect(creativePlanSchema.safeParse(longTitle).success).toBe(false);
  });
});

describe('request contracts', () => {
  it('fills batch defaults and rejects duplicate products', () => {
    const parsed = createBatchRequestSchema.parse({
      idempotencyKey: '3f6c2a64-4d54-4c0b-9a5e-6c1f0b6f8d11',
      products: [{ productGid: gid(1) }],
    });
    expect(parsed.commonReferenceMediaIds).toEqual([]);
    expect(parsed.products[0]?.referenceMediaIds).toEqual([]);

    const duplicate = createBatchRequestSchema.safeParse({
      idempotencyKey: '3f6c2a64-4d54-4c0b-9a5e-6c1f0b6f8d11',
      products: [{ productGid: gid(1) }, { productGid: gid(1) }],
    });
    expect(duplicate.success).toBe(false);
    expect(createBatchRequestSchema.safeParse({ idempotencyKey: 'nope', products: [{ productGid: gid(1) }] }).success).toBe(false);
  });

  it('requires productGid exactly for product-scoped uploads', () => {
    const base = { clientId: 'c1', filename: 'a.jpg', mimeType: 'image/jpeg', fileSize: 1000 };
    expect(uploadFileRequestSchema.safeParse({ ...base, scope: 'common' }).success).toBe(true);
    expect(uploadFileRequestSchema.safeParse({ ...base, scope: 'product', productGid: gid(1) }).success).toBe(true);
    expect(uploadFileRequestSchema.safeParse({ ...base, scope: 'product' }).success).toBe(false);
    expect(uploadFileRequestSchema.safeParse({ ...base, scope: 'common', productGid: gid(1) }).success).toBe(false);
  });

  it('parses comma separated media ids and caps them at 50', () => {
    expect(mediaListQuerySchema.parse({ ids: `${id(1)},${id(2)}` }).ids).toEqual([id(1), id(2)]);
    expect(mediaListQuerySchema.safeParse({ ids: 'not-an-id' }).success).toBe(false);
    const tooMany = Array.from({ length: 51 }, (_, i) => id(i + 1)).join(',');
    expect(mediaListQuerySchema.safeParse({ ids: tooMany }).success).toBe(false);
  });

  it('coerces pagination query strings with defaults and a max of 50', () => {
    expect(paginationQuerySchema.parse({})).toEqual({ limit: 25 });
    expect(productListQuerySchema.parse({ limit: '10', q: ' lamp ' })).toEqual({ limit: 10, q: 'lamp' });
    expect(productListQuerySchema.safeParse({ limit: '51' }).success).toBe(false);
  });

  it('validates the PKCE exchange request', () => {
    const body = { code: 'abc', codeVerifier: 'v'.repeat(43), platform: 'android' };
    expect(authExchangeRequestSchema.safeParse(body).success).toBe(true);
    expect(authExchangeRequestSchema.safeParse({ ...body, codeVerifier: 'short' }).success).toBe(false);
  });
});

describe('helpers and envelopes', () => {
  it('normalizes and validates shop domains', () => {
    expect(normalizeShopDomain('  My-Store ')).toBe('my-store.myshopify.com');
    expect(normalizeShopDomain('my-store.myshopify.com')).toBe('my-store.myshopify.com');
    expect(shopDomainSchema.safeParse(normalizeShopDomain('My-Store')).success).toBe(true);
    expect(shopDomainSchema.safeParse(normalizeShopDomain('bad domain!')).success).toBe(false);
    expect(shopDomainSchema.safeParse(normalizeShopDomain('')).success).toBe(false);
  });

  it('maps every error code to an http status and parses envelopes', () => {
    for (const code of ERROR_CODES) expect(ERROR_HTTP_STATUS[code]).toBeGreaterThanOrEqual(400);
    const envelope = { error: { code: 'references_required', message: 'x', details: { productGids: [gid(1)] } } };
    expect(errorEnvelopeSchema.safeParse(envelope).success).toBe(true);
    expect(errorEnvelopeSchema.safeParse({ error: { code: 'nope', message: 'x' } }).success).toBe(false);
  });

  it('knows terminal batch statuses', () => {
    expect(isTerminalBatchStatus('completed_with_errors')).toBe(true);
    expect(isTerminalBatchStatus('running')).toBe(false);
  });
});
