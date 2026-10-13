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

// The descriptions go to the planner as part of the response schema, and the property order is the order the model
// writes in: the decisions that shape a shot (scene, camera, light, people, move) come before the prompt that
// brings them together. Keep the order when adding fields.
const DESCRIPTIONS = {
  shotId: 'A short unique id, for example image-1 or video-1.',
  title: 'A short name for the shot, at most 60 characters.',
  scene: 'One sentence: where the shot takes place and what stands or sits around the product.',
  camera:
    'Shot type, angle, lens and framing, for example "full-length, eye-level, 50mm lens, the whole outfit in frame". Everything is in deep focus.',
  lighting: 'Direction, quality and time of day of the light, for example "soft window light from the left, late morning".',
  people: 'The word none, or one adult model in a calm, natural pose.',
  cameraMove:
    'One real camera move: locked-off tripod, slow pan, slow tilt, dolly in, tracking, arc, or subtle handheld. Chosen before the prompt is written.',
  subjectAction: 'One small, physically real action of the subject or the fabric, or the word none.',
  prompt:
    'A narrative paragraph of 60 to 140 words describing the final image or video: shot type, the subject wearing the exact garment, the pose or action, the environment with named props, the light, the camera and lens, the palette and mood. Describe what is in the frame.',
  negative: 'Visual defects to avoid, as short noun phrases, for example "warped hands, extra objects, text".',
} as const;

const shotStart = {
  shotId: z.string().min(1).describe(DESCRIPTIONS.shotId),
  title: z.string().min(1).max(PLAN_LIMITS.titleMaxChars).describe(DESCRIPTIONS.title),
  scene: z.string().min(1).describe(DESCRIPTIONS.scene),
  camera: z.string().min(1).describe(DESCRIPTIONS.camera),
  lighting: z.string().min(1).describe(DESCRIPTIONS.lighting),
  people: z.string().min(1).describe(DESCRIPTIONS.people),
};

const shotEnd = {
  prompt: z.string().min(1).max(PLAN_LIMITS.promptMaxChars).describe(DESCRIPTIONS.prompt),
  negative: z.string().describe(DESCRIPTIONS.negative),
};

export const imageShotSchema = z.object({ ...shotStart, ...shotEnd });

export const videoShotSchema = z.object({
  ...shotStart,
  cameraMove: z.string().min(1).describe(DESCRIPTIONS.cameraMove),
  subjectAction: z.string().min(1).describe(DESCRIPTIONS.subjectAction),
  ...shotEnd,
});

export const creativePlanSchema = z.object({
  product: z.object({
    category: z.string().min(1).describe('Short product category, for example "denim co-ord set".'),
    keyAttributes: z
      .array(z.string().min(1))
      .max(PLAN_LIMITS.keyAttributes.max)
      .describe('3 to 8 distinctive attributes: fabric, cut, color, print, hardware.'),
    mustPreserve: z
      .array(z.string().min(1))
      .min(1)
      .describe(
        'The garment checklist: one entry per visible piece or distinctive detail with exact colors and fabric words, for example "Top: ...", "Bottom: ...", "Print: ...", "Hardware: ...".',
      ),
    scaleHint: z.string().describe('How large the product is relative to the body or to common objects.'),
  }),
  referenceStyle: z.object({
    setting: z.string().describe('The specific environment, with the backdrop color and surface and the props that stand in it.'),
    lighting: z.string().describe('Direction, quality and time of day of the light.'),
    palette: z.string().describe('The dominant colors of the scene.'),
    mood: z.string().describe('The feeling of the scene in a few words.'),
    composition: z.string().describe('Framing, camera distance and how the subject is placed.'),
    motion: z.string().describe('How the camera and the subject move in the video shots.'),
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
