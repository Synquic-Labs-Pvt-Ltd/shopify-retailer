import { z } from 'zod';
import { DB_STATES, LANE_PAUSE_REASONS } from '../enums';
import { isoDateTimeSchema } from './common';

// GET /health
export const healthResponseSchema = z.object({
  ok: z.boolean(),
  db: z.enum(DB_STATES),
  worker: z.object({
    lastTickAt: isoDateTimeSchema.nullable(),
  }),
  pausedLanes: z.array(
    z.object({
      lane: z.string(),
      reason: z.enum(LANE_PAUSE_REASONS),
      pausedUntil: isoDateTimeSchema,
    }),
  ),
});

export type HealthResponse = z.infer<typeof healthResponseSchema>;
