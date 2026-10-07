import { z } from 'zod';
import { PRODUCT_STATUSES } from '@rs/shared';

// Shape of the Admin API responses this module reads. They are parsed at the boundary so the rest
// of the module works with typed data and never with casts.

const previewImage = z
  .object({ preview: z.object({ image: z.object({ url: z.string() }).nullable() }).nullable() })
  .nullable();

const count = z.object({ count: z.number().int().min(0) }).nullable();

export const productListNodeSchema = z.object({
  id: z.string(),
  title: z.string(),
  handle: z.string(),
  status: z.enum(PRODUCT_STATUSES),
  vendor: z.string(),
  productType: z.string(),
  featuredMedia: previewImage,
  mediaCount: count,
  variantsCount: count,
});

export const productListDataSchema = z.object({
  products: z.object({
    nodes: z.array(productListNodeSchema),
    pageInfo: z.object({ hasNextPage: z.boolean(), endCursor: z.string().nullable() }),
  }),
});

export const productSnapshotNodeSchema = z.object({
  id: z.string(),
  title: z.string(),
  handle: z.string(),
  descriptionHtml: z.string(),
  productType: z.string(),
  vendor: z.string(),
  tags: z.array(z.string()),
  options: z.array(z.object({ name: z.string(), values: z.array(z.string()) })),
  featuredMedia: previewImage,
  media: z.object({
    // Non-image media nodes carry no fields because only the MediaImage fragment is selected.
    nodes: z.array(z.object({ image: z.object({ url: z.string() }).nullable().optional() })),
  }),
});

export const productDetailDataSchema = z.object({ product: productSnapshotNodeSchema.nullable() });

// A missing node comes back as null, a node that is not a Product as an empty object.
export const productSnapshotsDataSchema = z.object({ nodes: z.array(z.unknown()) });

export type ProductListNode = z.infer<typeof productListNodeSchema>;
export type ProductSnapshotNode = z.infer<typeof productSnapshotNodeSchema>;
