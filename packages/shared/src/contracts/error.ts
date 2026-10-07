import { z } from 'zod';
import { ERROR_CODES } from '../enums';
import { productGidSchema } from './common';

export const errorCodeSchema = z.enum(ERROR_CODES);

// Error envelope (SPEC 15): error.code, error.message, optional error.details.
export const errorEnvelopeSchema = z.object({
  error: z.object({
    code: errorCodeSchema,
    message: z.string(),
    details: z.unknown().optional(),
  }),
});

// details of a 422 references_required response (SPEC 9).
export const referencesRequiredDetailsSchema = z.object({
  productGids: z.array(productGidSchema),
});

export type ErrorEnvelope = z.infer<typeof errorEnvelopeSchema>;
export type ReferencesRequiredDetails = z.infer<typeof referencesRequiredDetailsSchema>;
