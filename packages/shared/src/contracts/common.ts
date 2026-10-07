import { z } from 'zod';

export const objectIdSchema = z.string().regex(/^[a-f0-9]{24}$/, 'Expected a 24-character hex id');

export const isoDateTimeSchema = z.iso.datetime();

// Product ids are Shopify GIDs (SPEC 14 conventions).
export const productGidSchema = z.string().regex(/^gid:\/\/shopify\/Product\/\d+$/, 'Expected a Shopify product GID');

export const pageInfoSchema = z.object({
  endCursor: z.string().nullable(),
  hasNextPage: z.boolean(),
});

export const paginationQuerySchema = z.object({
  cursor: z.string().min(1).max(512).optional(),
  limit: z.coerce.number().int().min(1).max(50).default(25),
});

export const idParamsSchema = z.object({ id: objectIdSchema });

export type PageInfo = z.infer<typeof pageInfoSchema>;
export type PaginationQuery = z.infer<typeof paginationQuerySchema>;
// Client-side shape: every field optional.
export type PaginationParams = Partial<PaginationQuery>;
export type IdParams = z.infer<typeof idParamsSchema>;
