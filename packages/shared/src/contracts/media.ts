import { z } from 'zod';
import { MEDIA_ROLES, MEDIA_SCOPES, MEDIA_STATUSES, MEDIA_TYPES } from '../enums';
import { isoDateTimeSchema, objectIdSchema, productGidSchema } from './common';

// Media object (SPEC 15 shapes).
export const mediaObjectSchema = z.object({
  id: objectIdSchema,
  role: z.enum(MEDIA_ROLES),
  mediaType: z.enum(MEDIA_TYPES),
  status: z.enum(MEDIA_STATUSES),
  url: z.string().nullable(),
  previewUrl: z.string().nullable(),
  width: z.number().int().positive().nullable(),
  height: z.number().int().positive().nullable(),
  durationSec: z.number().min(0).nullable(),
  filename: z.string(),
  scope: z.enum(MEDIA_SCOPES).nullable(),
  productGid: productGidSchema.nullable(),
  shotTitle: z.string().nullable(),
  createdAt: isoDateTimeSchema,
});

// POST /api/v1/media/uploads
export const uploadFileRequestSchema = z
  .object({
    clientId: z.string().min(1).max(64),
    filename: z.string().min(1).max(255),
    mimeType: z.string().min(1).max(100),
    fileSize: z.number().int().positive(),
    durationSec: z.number().positive().optional(),
    scope: z.enum(MEDIA_SCOPES),
    productGid: productGidSchema.optional(),
  })
  .refine((file) => (file.scope === 'product' ? file.productGid !== undefined : file.productGid === undefined), {
    message: 'productGid is required for product scope and not allowed for common scope',
    path: ['productGid'],
  });

export const uploadsRequestSchema = z.object({
  files: z.array(uploadFileRequestSchema).min(1).max(50),
});

export const uploadParameterSchema = z.object({
  name: z.string(),
  value: z.string(),
});

export const uploadTargetSchema = z.object({
  clientId: z.string(),
  mediaId: objectIdSchema,
  url: z.string(),
  method: z.literal('POST'),
  parameters: z.array(uploadParameterSchema),
});

export const uploadsResponseSchema = z.object({
  targets: z.array(uploadTargetSchema),
});

// POST /api/v1/media/:id/complete returns a media object. DELETE /api/v1/media/:id returns 204 or 409 in_use.
export const mediaCompleteResponseSchema = mediaObjectSchema;

// GET /api/v1/media?ids=a,b,c (max 50)
export const mediaListQuerySchema = z.object({
  ids: z
    .string()
    .min(1)
    .transform((value) => value.split(',').map((id) => id.trim()))
    .pipe(z.array(objectIdSchema).min(1).max(50)),
});

export const mediaListResponseSchema = z.object({
  items: z.array(mediaObjectSchema),
});

export type MediaObject = z.infer<typeof mediaObjectSchema>;
export type UploadFileRequest = z.infer<typeof uploadFileRequestSchema>;
export type UploadsRequest = z.infer<typeof uploadsRequestSchema>;
export type UploadParameter = z.infer<typeof uploadParameterSchema>;
export type UploadTarget = z.infer<typeof uploadTargetSchema>;
export type UploadsResponse = z.infer<typeof uploadsResponseSchema>;
export type MediaCompleteResponse = z.infer<typeof mediaCompleteResponseSchema>;
export type MediaListQuery = z.infer<typeof mediaListQuerySchema>;
export type MediaListResponse = z.infer<typeof mediaListResponseSchema>;
