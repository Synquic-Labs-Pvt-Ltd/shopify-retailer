import { z } from 'zod';
import { PROMPT_NAMES } from '../enums';
import { PROMPT_MAX_CHARS, PROMPT_NOTE_MAX_CHARS } from '../prompts';
import { isoDateTimeSchema } from './common';

// Per-store prompts (SPEC 12.6). Version 0 is always the global default; a store's edits are versions 1, 2, ...

export const promptNameSchema = z.enum(PROMPT_NAMES);

export const promptPlaceholderSchema = z.object({
  name: z.string(),
  required: z.boolean(),
  description: z.string(),
});

// GET /api/v1/prompts
export const promptSummarySchema = z.object({
  name: promptNameSchema,
  title: z.string(),
  description: z.string(),
  placeholders: z.array(promptPlaceholderSchema),
  // The version new generations use. 0 is the global default.
  activeVersion: z.number().int().min(0),
  // The highest version this store has saved (0 when it never edited the prompt).
  latestVersion: z.number().int().min(0),
  // True when the store's own version is active.
  isCustom: z.boolean(),
  // When the active custom version was saved. Null for the global default.
  updatedAt: isoDateTimeSchema.nullable(),
});

export const promptListResponseSchema = z.object({
  items: z.array(promptSummarySchema),
});

export const promptVersionSchema = z.object({
  version: z.number().int().min(0),
  source: z.enum(['global', 'store']),
  // Null for the global default.
  createdAt: isoDateTimeSchema.nullable(),
  note: z.string().nullable(),
  chars: z.number().int().min(0),
  active: z.boolean(),
});

// GET /api/v1/prompts/:name. Also the response of a save and of an activation.
export const promptDetailSchema = promptSummarySchema.extend({
  // The text of the active version.
  text: z.string(),
  // The global default text (version 0), for comparing and for "reset".
  globalText: z.string(),
  // Newest first; the global default (version 0) is always the last entry.
  versions: z.array(promptVersionSchema),
});

// GET /api/v1/prompts/:name/versions/:version
export const promptVersionTextSchema = promptVersionSchema.extend({
  text: z.string(),
});

// PUT /api/v1/prompts/:name: saves the text as the next version and makes it the active one.
export const savePromptRequestSchema = z.object({
  text: z.string().min(1).max(PROMPT_MAX_CHARS * 2),
  note: z.string().trim().max(PROMPT_NOTE_MAX_CHARS).optional(),
});

// POST /api/v1/prompts/:name/activate: version 0 resets the store to the global default.
export const activatePromptRequestSchema = z.object({
  version: z.number().int().min(0),
});

export const promptVersionParamsSchema = z.object({
  name: promptNameSchema,
  version: z.coerce.number().int().min(0),
});

// What generated a media output: the store version of the prompts behind it (0 is the global default).
// planner is null when the plan came from the fallback plan instead of the planner prompt.
export const mediaPromptsSchema = z.object({
  planner: z.number().int().min(0).nullable(),
  render: z.number().int().min(0),
});

export type PromptSummary = z.infer<typeof promptSummarySchema>;
export type PromptListResponse = z.infer<typeof promptListResponseSchema>;
export type PromptVersionInfo = z.infer<typeof promptVersionSchema>;
export type PromptDetail = z.infer<typeof promptDetailSchema>;
export type PromptVersionText = z.infer<typeof promptVersionTextSchema>;
export type SavePromptRequest = z.infer<typeof savePromptRequestSchema>;
export type ActivatePromptRequest = z.infer<typeof activatePromptRequestSchema>;
export type MediaPrompts = z.infer<typeof mediaPromptsSchema>;
