import { z } from 'zod';
import { PRODUCT_STATUSES } from '../enums';
import { pageInfoSchema, paginationQuerySchema, productGidSchema } from './common';

// Every product image the snapshot keeps, the featured one included.
export const PRODUCT_SNAPSHOT_MAX_IMAGES = 12;

export const productStatusSchema = z.enum(PRODUCT_STATUSES);

// GET /api/v1/products. q is passed to Shopify search syntax, scoped to title (SPEC 8.5).
export const PRODUCT_LIST_STATUS_FILTERS = ['active', 'draft'] as const;

// status narrows the list on the server so pages and counts stay consistent; omitted lists every status.
export const productListQuerySchema = paginationQuerySchema.extend({
  q: z.string().trim().max(200).optional(),
  status: z.enum(PRODUCT_LIST_STATUS_FILTERS).optional(),
});

export const productListItemSchema = z.object({
  id: productGidSchema,
  title: z.string(),
  handle: z.string(),
  status: productStatusSchema,
  vendor: z.string(),
  productType: z.string(),
  imageUrl: z.string().nullable(),
  mediaCount: z.number().int().min(0),
  variantsCount: z.number().int().min(0),
});

export const productListResponseSchema = z.object({
  items: z.array(productListItemSchema),
  pageInfo: pageInfoSchema,
});

// GET /api/v1/products/:gid. The gid path segment is url-encoded.
export const productGidParamsSchema = z.object({ gid: productGidSchema });

export const productOptionSchema = z.object({
  name: z.string(),
  values: z.array(z.string()),
});

// Stored on batch items (SPEC 14.8) and returned as the detail body (SPEC 8.5).
// descriptionText is the description with HTML stripped, at most 2000 characters.
export const productSnapshotSchema = z.object({
  title: z.string(),
  handle: z.string(),
  descriptionText: z.string().max(2000),
  productType: z.string(),
  vendor: z.string(),
  tags: z.array(z.string()),
  options: z.array(productOptionSchema),
  featuredImageUrl: z.string().nullable(),
  imageUrls: z.array(z.string()).max(PRODUCT_SNAPSHOT_MAX_IMAGES),
});

export const productDetailSchema = productSnapshotSchema.extend({
  id: productGidSchema,
});

export type ProductListQuery = z.infer<typeof productListQuerySchema>;
export type ProductListParams = Partial<ProductListQuery>;
export type ProductListItem = z.infer<typeof productListItemSchema>;
export type ProductListResponse = z.infer<typeof productListResponseSchema>;
export type ProductGidParams = z.infer<typeof productGidParamsSchema>;
export type ProductOption = z.infer<typeof productOptionSchema>;
export type ProductSnapshot = z.infer<typeof productSnapshotSchema>;
export type ProductDetail = z.infer<typeof productDetailSchema>;
