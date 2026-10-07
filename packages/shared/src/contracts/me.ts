import { z } from 'zod';
import { outputsConfigSchema, referencesConfigSchema } from '../config/generation-config';
import { shopSchema, userSchema } from './auth';

// GET /api/v1/me
export const meGenerationSchema = z.object({
  imagesPerProduct: outputsConfigSchema.shape.imagesPerProduct,
  videosPerProduct: outputsConfigSchema.shape.videosPerProduct,
  references: referencesConfigSchema,
  maxProductsPerBatch: z.number().int().positive(),
});

export const meResponseSchema = z.object({
  user: userSchema,
  shop: shopSchema,
  generation: meGenerationSchema,
});

export type MeGeneration = z.infer<typeof meGenerationSchema>;
export type MeResponse = z.infer<typeof meResponseSchema>;
