import { PROMPT_NAMES, type PromptName } from './enums';

// Per-store prompt editing (SPEC 12.6). The global defaults live in apps/backend/config/prompts as version 0;
// a store's edits are numbered versions 1, 2, 3, ... of its own.

export const PROMPT_MAX_CHARS = 20_000;
export const PROMPT_NOTE_MAX_CHARS = 200;
// A store keeps at most this many versions of one prompt.
export const PROMPT_MAX_VERSIONS = 200;

export interface PromptPlaceholder {
  name: string;
  // A prompt without it is rejected: the pipeline would lose a fact it needs.
  required: boolean;
  description: string;
}

export interface PromptDefinition {
  name: PromptName;
  title: string;
  description: string;
  placeholders: readonly PromptPlaceholder[];
}

export const PROMPT_DEFINITIONS: Readonly<Record<PromptName, PromptDefinition>> = {
  'planner.system': {
    name: 'planner.system',
    title: 'Creative director (shot plan)',
    description:
      'The system prompt of the planner. It looks at the product photos and plans every shot for one product: scenes, camera, light and the garment checklist. Runs once per product.',
    placeholders: [
      { name: 'imageCount', required: true, description: 'How many image shots to plan.' },
      { name: 'videoCount', required: true, description: 'How many video shots to plan.' },
      { name: 'videoDurationSeconds', required: false, description: 'Length of each video in seconds.' },
      { name: 'videoAspectRatio', required: false, description: 'Aspect ratio of each video, for example 9:16.' },
      {
        name: 'styleGuidance',
        required: true,
        description: 'The aesthetic the merchant picked (from the apparel, studio or references), written out for the planner.',
      },
    ],
  },
  'image.user': {
    name: 'image.user',
    title: 'Image shot',
    description: 'The prompt sent to the image model for each planned still image, together with the product photos and style references.',
    placeholders: [
      { name: 'shot.prompt', required: true, description: 'The planned description of this shot.' },
      { name: 'shot.camera', required: false, description: 'Camera and framing for this shot.' },
      { name: 'shot.lighting', required: false, description: 'Lighting for this shot.' },
      { name: 'shot.people', required: false, description: 'Who appears in this shot, or none.' },
      { name: 'shot.negative', required: false, description: 'Visual defects to avoid for this shot.' },
      { name: 'plan.product.mustPreserve', required: true, description: 'The garment checklist the planner wrote for this product.' },
      { name: 'image.aspectRatio', required: false, description: 'Aspect ratio of the image, for example 3:4.' },
    ],
  },
  'video.user': {
    name: 'video.user',
    title: 'Video shot',
    description: 'The prompt sent to the video model for each planned video, together with the product photos.',
    placeholders: [
      { name: 'shot.prompt', required: true, description: 'The planned description of this shot.' },
      { name: 'shot.cameraMove', required: false, description: 'The camera move for this shot.' },
      { name: 'shot.subjectAction', required: false, description: 'What the subject does in this shot.' },
      { name: 'shot.lighting', required: false, description: 'Lighting for this shot.' },
      { name: 'plan.product.mustPreserve', required: true, description: 'The garment checklist the planner wrote for this product.' },
    ],
  },
};

export function isPromptName(value: string): value is PromptName {
  return (PROMPT_NAMES as readonly string[]).includes(value);
}

// The same normalization the global prompt files get, so a version's hash does not depend on the platform.
export function normalizePromptText(raw: string): string {
  return raw.replace(/^﻿/, '').replace(/\r\n/g, '\n').trimEnd();
}

// Same pattern the renderer substitutes (apps/backend/src/modules/ai/prompts.ts).
const PLACEHOLDER = /\{\{\s*([A-Za-z0-9_.-]+)\s*\}\}/g;

export function usedPlaceholders(text: string): string[] {
  return [...new Set([...text.matchAll(PLACEHOLDER)].map((match) => match[1] ?? ''))];
}

export type PromptValidation = { ok: true; text: string } | { ok: false; errors: string[] };

// Checks a prompt before it is stored: a placeholder the renderer does not know would crash every job that uses it,
// and a missing required one would silently drop a fact the pipeline depends on.
export function validatePromptText(name: PromptName, raw: string): PromptValidation {
  const text = normalizePromptText(raw);
  const errors: string[] = [];
  if (text.length === 0) return { ok: false, errors: ['The prompt cannot be empty.'] };
  if (text.length > PROMPT_MAX_CHARS) errors.push(`The prompt is too long: ${text.length} characters, the limit is ${PROMPT_MAX_CHARS}.`);

  const definition = PROMPT_DEFINITIONS[name];
  const allowed = new Set(definition.placeholders.map((placeholder) => placeholder.name));
  const used = usedPlaceholders(text);
  for (const placeholder of used) {
    if (!allowed.has(placeholder)) errors.push(`Unknown placeholder {{${placeholder}}}. Allowed: ${[...allowed].map((n) => `{{${n}}}`).join(', ')}.`);
  }
  for (const placeholder of definition.placeholders) {
    if (placeholder.required && !used.includes(placeholder.name)) errors.push(`Missing required placeholder {{${placeholder.name}}}.`);
  }
  if (text.replace(PLACEHOLDER, '').match(/\{\{|\}\}/) !== null) {
    errors.push('A placeholder is malformed. Write it as {{name}} with no spaces inside the name.');
  }
  return errors.length === 0 ? { ok: true, text } : { ok: false, errors };
}
