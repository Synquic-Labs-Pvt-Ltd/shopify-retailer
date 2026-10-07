import { z } from 'zod';

// Creative plan (SPEC 12.2). Hard limits here protect storage and UI. The word and attribute
// targets in PLAN_LIMITS are prompt guidance, not validation, so the deterministic fallback
// plan (SPEC 12.5), which is shorter, validates against the same schema.

export const PLAN_LIMITS = {
  titleMaxChars: 60,
  promptWords: { min: 60, max: 140 },
  keyAttributes: { min: 3, max: 8 },
  promptMaxChars: 2000,
} as const;

const shotFields = {
  shotId: z.string().min(1),
  title: z.string().min(1).max(PLAN_LIMITS.titleMaxChars),
  scene: z.string().min(1),
  camera: z.string().min(1),
  lighting: z.string().min(1),
  people: z.string().min(1),
  prompt: z.string().min(1).max(PLAN_LIMITS.promptMaxChars),
  negative: z.string(),
};

export const imageShotSchema = z.object(shotFields);

export const videoShotSchema = z.object({
  ...shotFields,
  cameraMove: z.string().min(1),
  subjectAction: z.string().min(1),
});

export const creativePlanSchema = z.object({
  product: z.object({
    category: z.string().min(1),
    keyAttributes: z.array(z.string().min(1)).max(PLAN_LIMITS.keyAttributes.max),
    mustPreserve: z.array(z.string().min(1)).min(1),
    scaleHint: z.string(),
  }),
  referenceStyle: z.object({
    setting: z.string(),
    lighting: z.string(),
    palette: z.string(),
    mood: z.string(),
    composition: z.string(),
    motion: z.string(),
  }),
  imageShots: z.array(imageShotSchema),
  videoShots: z.array(videoShotSchema),
  warnings: z.array(z.string()),
});

export interface PlanCounts {
  imageCount: number;
  videoCount: number;
}

// The planner must return exactly imageCount image shots and videoCount video shots.
export function createCreativePlanSchema(counts: PlanCounts) {
  return creativePlanSchema.extend({
    imageShots: z.array(imageShotSchema).length(counts.imageCount),
    videoShots: z.array(videoShotSchema).length(counts.videoCount),
  });
}

export type ImageShot = z.infer<typeof imageShotSchema>;
export type VideoShot = z.infer<typeof videoShotSchema>;
export type CreativePlan = z.infer<typeof creativePlanSchema>;
