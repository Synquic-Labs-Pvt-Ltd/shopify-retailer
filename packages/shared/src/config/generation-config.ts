import { z } from 'zod';
import {
  AI_PROVIDERS,
  IMAGE_OUTPUT_MIME_TYPES,
  IMAGE_SIZES,
  PERSON_GENERATION_MODES,
  STORAGE_PROVIDERS,
  VIDEO_ASPECT_RATIOS,
  VIDEO_MODES,
  VIDEO_RESOLUTIONS,
} from '../enums';

// Schema for apps/backend/config/generation.config.json (SPEC 13).
// Objects are strict so a typo in the file is rejected instead of silently ignored.

const positiveInt = z.number().int().positive();
const nonNegativeInt = z.number().int().min(0);

function isValidTimeZone(zone: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}

export const outputsConfigSchema = z.strictObject({
  imagesPerProduct: z.number().int().min(0).max(6),
  videosPerProduct: z.number().int().min(0).max(2),
});

export const modelsConfigSchema = z.strictObject({
  planner: z.string().min(1),
  image: z.string().min(1),
  video: z.string().min(1),
});

export const locationsConfigSchema = z.strictObject({
  planner: z.string().min(1),
  image: z.string().min(1),
  video: z.string().min(1),
});

export const imageConfigSchema = z.strictObject({
  aspectRatio: z.string().regex(/^\d{1,2}:\d{1,2}$/, 'Expected a ratio such as 3:4'),
  imageSize: z.enum(IMAGE_SIZES),
  outputMimeType: z.enum(IMAGE_OUTPUT_MIME_TYPES),
});

export const aiConfigSchema = z.strictObject({
  image: z.strictObject({
    maxProductImages: positiveInt,
    maxStyleReferences: nonNegativeInt,
  }),
  planner: z.strictObject({
    maxReferenceImages: nonNegativeInt,
    maxReferenceVideos: nonNegativeInt,
    temperature: z.number().min(0).max(2),
  }),
});

export const videoConfigSchema = z
  .strictObject({
    // reference_images (default): product images go in as Veo reference assets. image_to_video: the first
    // product image is the first frame. Switchable live; batches snapshot the value at creation.
    mode: z.enum(VIDEO_MODES).default('reference_images'),
    // Reference-image mode requires exactly 8 seconds. Image-to-video allows 4, 6 or 8.
    durationSeconds: z.union([z.literal(4), z.literal(6), z.literal(8)]),
    aspectRatio: z.enum(VIDEO_ASPECT_RATIOS),
    resolution: z.enum(VIDEO_RESOLUTIONS),
    generateAudio: z.boolean(),
    personGeneration: z.enum(PERSON_GENERATION_MODES),
    negativePrompt: z.string(),
  })
  .superRefine((video, ctx) => {
    if (video.mode === 'reference_images' && video.durationSeconds !== 8) {
      ctx.addIssue({ code: 'custom', message: 'durationSeconds must be 8 in reference_images mode', path: ['durationSeconds'] });
    }
    if (video.resolution === '1080p' && video.durationSeconds !== 8) {
      ctx.addIssue({ code: 'custom', message: '1080p supports only durationSeconds 8', path: ['durationSeconds'] });
    }
  });

export const referencesConfigSchema = z.strictObject({
  maxPerProduct: nonNegativeInt,
  maxCommon: nonNegativeInt,
  maxImageMB: positiveInt,
  maxVideoMB: positiveInt,
  maxVideoSeconds: positiveInt,
  imageMimeTypes: z.array(z.string().regex(/^image\/[a-z0-9.+-]+$/)).min(1),
  videoMimeTypes: z.array(z.string().regex(/^video\/[a-z0-9.+-]+$/)).min(1),
});

export const batchLimitsConfigSchema = z.strictObject({
  maxProductsPerBatch: positiveInt,
  maxActiveBatchesPerShop: positiveInt,
  maxJobsPerShopPerDay: positiveInt,
});

export const queueConfigSchema = z.strictObject({
  tickMs: positiveInt,
  leaseMs: positiveInt,
  maxAttempts: positiveInt,
  backoffBaseMs: positiveInt,
  backoffMaxMs: positiveInt,
  jobMaxAgeHours: positiveInt,
  videoPollIntervalMs: positiveInt,
  videoMaxWaitMinutes: positiveInt,
});

// A null limit means unlimited. Lane keys are "{provider}:{model}", "{provider}:poll"
// or the wildcard "{provider}:*" (see resolveLaneConfig).
export const laneConfigSchema = z.strictObject({
  rpm: positiveInt.nullable(),
  rph: positiveInt.nullable(),
  rpd: positiveInt.nullable(),
  maxConcurrent: positiveInt.nullable(),
  safetyFactor: z.number().gt(0).max(1),
  dailyResetTimeZone: z.string().min(1).refine(isValidTimeZone, 'Unknown IANA time zone'),
  pollLane: z.string().min(1).nullable(),
});

export const fakeConfigSchema = z.strictObject({
  latencyMs: nonNegativeInt,
  rateLimitProbability: z.number().min(0).max(1),
});

export const storageConfigSchema = z.strictObject({
  driver: z.enum(STORAGE_PROVIDERS),
});

export const generationConfigSchema = z
  .strictObject({
    version: z.literal(1),
    outputs: outputsConfigSchema,
    provider: z.enum(AI_PROVIDERS),
    models: modelsConfigSchema,
    locations: locationsConfigSchema,
    image: imageConfigSchema,
    ai: aiConfigSchema,
    video: videoConfigSchema,
    references: referencesConfigSchema,
    batch: batchLimitsConfigSchema,
    queue: queueConfigSchema,
    lanes: z.record(z.string().min(1), laneConfigSchema),
    fake: fakeConfigSchema,
    storage: storageConfigSchema,
  })
  .superRefine((config, ctx) => {
    for (const [name, lane] of Object.entries(config.lanes)) {
      if (lane.pollLane !== null && config.lanes[lane.pollLane] === undefined) {
        ctx.addIssue({
          code: 'custom',
          message: `Lane "${name}" references unknown pollLane "${lane.pollLane}"`,
          path: ['lanes', name, 'pollLane'],
        });
      }
    }
  });

export type OutputsConfig = z.infer<typeof outputsConfigSchema>;
export type ModelsConfig = z.infer<typeof modelsConfigSchema>;
export type LocationsConfig = z.infer<typeof locationsConfigSchema>;
export type ImageConfig = z.infer<typeof imageConfigSchema>;
export type AiConfig = z.infer<typeof aiConfigSchema>;
export type VideoConfig = z.infer<typeof videoConfigSchema>;
export type ReferencesConfig = z.infer<typeof referencesConfigSchema>;
export type BatchLimitsConfig = z.infer<typeof batchLimitsConfigSchema>;
export type QueueConfig = z.infer<typeof queueConfigSchema>;
export type LaneConfig = z.infer<typeof laneConfigSchema>;
export type FakeConfig = z.infer<typeof fakeConfigSchema>;
export type StorageConfig = z.infer<typeof storageConfigSchema>;
export type GenerationConfig = z.infer<typeof generationConfigSchema>;

export function laneKey(provider: string, model: string): string {
  return `${provider}:${model}`;
}

export function pollLaneKey(provider: string): string {
  return `${provider}:poll`;
}

// Exact lane first, then the provider wildcard ("fake:*").
export function resolveLaneConfig(lanes: Record<string, LaneConfig>, lane: string): LaneConfig | undefined {
  const exact = lanes[lane];
  if (exact !== undefined) return exact;
  const provider = lane.split(':')[0];
  return provider === undefined ? undefined : lanes[`${provider}:*`];
}

export const DEFAULT_VIDEO_NEGATIVE_PROMPT =
  'text, captions, subtitles, watermark, logo change, distorted product, morphing, product changing shape or color, duplicate product, extra limbs, flicker, low quality, cartoon, CGI look';

export const defaultGenerationConfig: GenerationConfig = {
  version: 1,
  outputs: { imagesPerProduct: 2, videosPerProduct: 1 },
  provider: 'vertex',
  models: {
    planner: 'gemini-2.5-flash',
    image: 'gemini-2.5-flash-image',
    video: 'veo-3.1-generate-001',
  },
  locations: { planner: 'us-central1', image: 'us-central1', video: 'us-central1' },
  image: { aspectRatio: '3:4', imageSize: '2K', outputMimeType: 'image/jpeg' },
  ai: {
    image: { maxProductImages: 3, maxStyleReferences: 3 },
    planner: { maxReferenceImages: 6, maxReferenceVideos: 2, temperature: 0.6 },
  },
  video: {
    mode: 'reference_images',
    durationSeconds: 8,
    aspectRatio: '9:16',
    resolution: '720p',
    generateAudio: false,
    personGeneration: 'allow_adult',
    negativePrompt: DEFAULT_VIDEO_NEGATIVE_PROMPT,
  },
  references: {
    maxPerProduct: 5,
    maxCommon: 10,
    maxImageMB: 20,
    maxVideoMB: 100,
    maxVideoSeconds: 60,
    imageMimeTypes: ['image/jpeg', 'image/png', 'image/webp'],
    videoMimeTypes: ['video/mp4', 'video/quicktime'],
  },
  batch: { maxProductsPerBatch: 50, maxActiveBatchesPerShop: 3, maxJobsPerShopPerDay: 300 },
  queue: {
    tickMs: 1000,
    leaseMs: 180000,
    maxAttempts: 3,
    backoffBaseMs: 5000,
    backoffMaxMs: 300000,
    jobMaxAgeHours: 24,
    videoPollIntervalMs: 15000,
    videoMaxWaitMinutes: 15,
  },
  lanes: {
    'vertex:gemini-2.5-flash': {
      rpm: 30,
      rph: 1000,
      rpd: 10000,
      maxConcurrent: 4,
      safetyFactor: 0.9,
      dailyResetTimeZone: 'UTC',
      pollLane: null,
    },
    'vertex:gemini-2.5-flash-image': {
      rpm: 10,
      rph: 300,
      rpd: 2000,
      maxConcurrent: 2,
      safetyFactor: 0.9,
      dailyResetTimeZone: 'UTC',
      pollLane: null,
    },
    'vertex:veo-3.1-generate-001': {
      rpm: 4,
      rph: 60,
      rpd: 300,
      maxConcurrent: 3,
      safetyFactor: 0.9,
      dailyResetTimeZone: 'UTC',
      pollLane: 'vertex:poll',
    },
    'vertex:poll': {
      rpm: 60,
      rph: null,
      rpd: null,
      maxConcurrent: null,
      safetyFactor: 0.9,
      dailyResetTimeZone: 'UTC',
      pollLane: null,
    },
    'fake:*': {
      rpm: 60,
      rph: null,
      rpd: null,
      maxConcurrent: 4,
      safetyFactor: 0.9,
      dailyResetTimeZone: 'UTC',
      pollLane: null,
    },
  },
  fake: { latencyMs: 3000, rateLimitProbability: 0 },
  storage: { driver: 'shopify' },
};
