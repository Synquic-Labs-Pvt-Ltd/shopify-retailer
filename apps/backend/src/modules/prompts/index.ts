import type { RequestHandler, Router } from 'express';
import type { PromptDetail, PromptListResponse, PromptName, PromptVersionText } from '@rs/shared';
import type { LoadedPrompt } from '../../core/config';
import type { Logger } from '../../core/logger';

export interface PromptActor {
  shopId: string;
  userId: string;
}

// A prompt template as a job uses it. version 0 is the global default (the file in config/prompts); a higher number
// is one of the store's own versions (SPEC 12.6).
export interface ResolvedPrompt {
  name: PromptName;
  text: string;
  // First 12 hex characters of the SHA-256 of the normalized text (the audit hash on jobs).
  hash: string;
  version: number;
  source: 'global' | 'store';
}

// The store's active version of each prompt.
export interface PromptRefs {
  planner: number;
  image: number;
  video: number;
}

export interface PromptsService {
  list(shopId: string): Promise<PromptListResponse>;
  get(shopId: string, name: PromptName): Promise<PromptDetail>;
  // 404 not_found for a version the store never saved. Version 0 is the global default.
  getVersion(shopId: string, name: PromptName, version: number): Promise<PromptVersionText>;
  // 400 validation_failed (details.errors) for a bad template, 429 shop_limit at the version cap. Saving the text
  // that is already active changes nothing.
  save(actor: PromptActor, name: PromptName, input: { text: string; note?: string | undefined }): Promise<PromptDetail>;
  // Makes a saved version active again. Version 0 is the global default (a reset). 404 for an unknown version.
  activate(actor: PromptActor, name: PromptName, version: number): Promise<PromptDetail>;
  // Generation: the text and identity of the version a batch froze. A missing store version falls back to global.
  resolve(shopId: string, name: PromptName, version: number): Promise<ResolvedPrompt>;
  // Batch creation: the store's active version of every prompt.
  activeRefs(shopId: string): Promise<PromptRefs>;
  // shop/redact: deletes the store's prompts and their history.
  purgeShop(shopId: string): Promise<void>;
}

export interface PromptsModuleOptions {
  // Verifies the bearer token and sets req.auth (auth module's requireAuth).
  requireAuth: RequestHandler;
  // The global defaults (version 0), hot reloaded from config/prompts.
  getGlobalPrompt: (name: PromptName) => LoadedPrompt;
  logger: Logger;
  now?: () => Date;
}

export interface PromptsModule {
  service: PromptsService;
  // Mount at /api/v1: GET /prompts, GET /prompts/:name, GET /prompts/:name/versions/:version, PUT /prompts/:name
  // and POST /prompts/:name/activate.
  router: Router;
  ensureIndexes(): Promise<void>;
}

export { createPromptsModule } from './module';
