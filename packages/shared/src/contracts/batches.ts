import { z } from 'zod';
import {
  imageConfigSchema,
  locationsConfigSchema,
  modelsConfigSchema,
  outputsConfigSchema,
  videoConfigSchema,
} from '../config/generation-config';
import {
  AI_PROVIDERS,
  BATCH_STATUSES,
  ITEM_STATUSES,
  JOB_ERROR_CODES,
  JOB_STATUSES,
  JOB_TYPES,
  LANE_PAUSE_REASONS,
  REFERENCE_MODES,
} from '../enums';
import { isoDateTimeSchema, objectIdSchema, pageInfoSchema, paginationQuerySchema, productGidSchema } from './common';
import { mediaObjectSchema } from './media';

export const batchStatusSchema = z.enum(BATCH_STATUSES);
export const itemStatusSchema = z.enum(ITEM_STATUSES);
export const referenceModeSchema = z.enum(REFERENCE_MODES);

// Stored on the batch at creation (SPEC 14.7). Counts, models and output parameters are frozen here.
export const batchConfigSnapshotSchema = z.object({
  outputs: outputsConfigSchema,
  provider: z.enum(AI_PROVIDERS),
  models: modelsConfigSchema,
  locations: locationsConfigSchema,
  image: imageConfigSchema,
  video: videoConfigSchema,
  promptVersions: z.object({
    planner: z.string(),
    image: z.string(),
    video: z.string(),
  }),
});

export const batchCountsSchema = z.object({
  products: z.number().int().min(0),
  jobsTotal: z.number().int().min(0),
  jobsSucceeded: z.number().int().min(0),
  jobsFailed: z.number().int().min(0),
  jobsCancelled: z.number().int().min(0),
  imagesReady: z.number().int().min(0),
  videosReady: z.number().int().min(0),
});

// POST /api/v1/batches
export const createBatchProductSchema = z.object({
  productGid: productGidSchema,
  referenceMediaIds: z.array(objectIdSchema).default([]),
});

export const createBatchRequestSchema = z
  .object({
    idempotencyKey: z.uuid(),
    products: z.array(createBatchProductSchema).min(1),
    commonReferenceMediaIds: z.array(objectIdSchema).default([]),
  })
  .refine((body) => new Set(body.products.map((p) => p.productGid)).size === body.products.length, {
    message: 'Each product may appear only once',
    path: ['products'],
  });

// Batch summary (SPEC 15 shapes). Returned by create, cancel, retry-failed and in lists.
export const batchSummarySchema = z.object({
  id: objectIdSchema,
  status: batchStatusSchema,
  counts: batchCountsSchema,
  createdAt: isoDateTimeSchema,
  finishedAt: isoDateTimeSchema.nullable(),
  coverImageUrl: z.string().nullable(),
  configSnapshot: z.object({ outputs: outputsConfigSchema }),
});

// GET /api/v1/batches
export const batchListQuerySchema = paginationQuerySchema;

export const batchListResponseSchema = z.object({
  items: z.array(batchSummarySchema),
  pageInfo: pageInfoSchema,
});

export const batchJobViewSchema = z.object({
  type: z.enum(JOB_TYPES),
  outputIndex: z.number().int().min(0).nullable(),
  status: z.enum(JOB_STATUSES),
  errorCode: z.enum(JOB_ERROR_CODES).nullable(),
});

export const batchItemViewSchema = z.object({
  id: objectIdSchema,
  productGid: productGidSchema,
  title: z.string(),
  imageUrl: z.string().nullable(),
  status: itemStatusSchema,
  referenceMode: referenceModeSchema,
  outputs: z.array(mediaObjectSchema),
  jobs: z.array(batchJobViewSchema),
});

// Present while a non-terminal job of the batch sits in a paused lane (SPEC 11.2).
export const batchDelaySchema = z.object({
  reason: z.enum(LANE_PAUSE_REASONS),
  resumesAt: isoDateTimeSchema,
});

// GET /api/v1/batches/:id
export const batchDetailSchema = batchSummarySchema.extend({
  items: z.array(batchItemViewSchema),
  delay: batchDelaySchema.nullable(),
});

// POST /api/v1/batches/:id/attach-media: adds the ready outputs of the batch to the Shopify products they were made
// for (one product per item). itemIds limits it to some items; omitted means every item of the batch.
export const attachMediaRequestSchema = z.object({
  itemIds: z.array(objectIdSchema).min(1).max(100).optional(),
});

export const attachMediaItemResultSchema = z.object({
  itemId: objectIdSchema,
  productGid: productGidSchema,
  // Newly added to the product, already on it from an earlier request, and not added (see error).
  attached: z.number().int().min(0),
  alreadyAttached: z.number().int().min(0),
  failed: z.number().int().min(0),
  error: z.string().nullable(),
});

export const attachMediaResponseSchema = z.object({
  items: z.array(attachMediaItemResultSchema),
  attached: z.number().int().min(0),
  alreadyAttached: z.number().int().min(0),
  failed: z.number().int().min(0),
});

export type BatchConfigSnapshot = z.infer<typeof batchConfigSnapshotSchema>;
export type BatchCounts = z.infer<typeof batchCountsSchema>;
export type CreateBatchProduct = z.infer<typeof createBatchProductSchema>;
export type CreateBatchRequest = z.infer<typeof createBatchRequestSchema>;
// Client-side shape: referenceMediaIds and commonReferenceMediaIds may be omitted.
export type CreateBatchInput = z.input<typeof createBatchRequestSchema>;
export type BatchSummary = z.infer<typeof batchSummarySchema>;
export type BatchListQuery = z.infer<typeof batchListQuerySchema>;
export type BatchListResponse = z.infer<typeof batchListResponseSchema>;
export type BatchJobView = z.infer<typeof batchJobViewSchema>;
export type BatchItemView = z.infer<typeof batchItemViewSchema>;
export type BatchDelay = z.infer<typeof batchDelaySchema>;
export type BatchDetail = z.infer<typeof batchDetailSchema>;
export type AttachMediaRequest = z.infer<typeof attachMediaRequestSchema>;
export type AttachMediaItemResult = z.infer<typeof attachMediaItemResultSchema>;
export type AttachMediaResponse = z.infer<typeof attachMediaResponseSchema>;
