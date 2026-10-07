import { createHash } from 'node:crypto';
import { readFileSync, watch, type FSWatcher } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { generationConfigSchema, laneKey, resolveLaneConfig, type GenerationConfig } from '@rs/shared';
import type { Logger } from './logger';

export const PROMPT_NAMES = ['planner.system', 'image.user', 'video.user'] as const;
export type PromptName = (typeof PROMPT_NAMES)[number];

export interface LoadedPrompt {
  name: PromptName;
  text: string;
  // First 12 hex characters of the SHA-256 of the normalized template text.
  version: string;
}

export interface PromptVersions {
  planner: string;
  image: string;
  video: string;
}

export interface ReloadResult {
  ok: boolean;
  errors: string[];
}

export interface ConfigService {
  get(): GenerationConfig;
  getPrompt(name: PromptName): LoadedPrompt;
  getPromptVersions(): PromptVersions;
  // Re-reads the config and prompt files now. Invalid files are rejected and the last good values stay.
  reload(): ReloadResult;
  close(): void;
}

export interface ConfigServiceOptions {
  logger: Logger;
  // Defaults to config/generation.config.json. GENERATION_CONFIG_PATH is passed in here by server.ts.
  configPath?: string;
  // Defaults to config/prompts, independent of configPath.
  promptsDir?: string;
  // Defaults to true.
  watch?: boolean;
  // Defaults to 500.
  debounceMs?: number;
}

const BACKEND_ROOT = fileURLToPath(new URL('../../', import.meta.url));
export const DEFAULT_CONFIG_PATH = join(BACKEND_ROOT, 'config', 'generation.config.json');
export const DEFAULT_PROMPTS_DIR = join(BACKEND_ROOT, 'config', 'prompts');

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function stripBom(text: string): string {
  return text.replace(/^﻿/, '');
}

// The governor refuses every claim for a lane that has no entry, so a model without a lane would stall all of
// its jobs without any error reaching the app. An edit like that is rejected like any other invalid config.
function assertLanesCoverModels(config: GenerationConfig): void {
  const missing = Object.values(config.models)
    .map((model) => laneKey(config.provider, model))
    .filter((lane) => resolveLaneConfig(config.lanes, lane) === undefined);
  if (missing.length > 0) {
    throw new ConfigError(`Invalid generation config:\n  - lanes: no lane for ${[...new Set(missing)].join(', ')} (add it, or "${config.provider}:*")`);
  }
}

export function parseGenerationConfig(raw: string): GenerationConfig {
  let json: unknown;
  try {
    json = JSON.parse(stripBom(raw));
  } catch (err) {
    throw new ConfigError(`Invalid JSON: ${describe(err)}`);
  }
  const result = generationConfigSchema.safeParse(json);
  if (!result.success) {
    const issues = result.error.issues.map((issue) => `${issue.path.map(String).join('.') || '(root)'}: ${issue.message}`);
    throw new ConfigError(`Invalid generation config:\n${issues.map((issue) => `  - ${issue}`).join('\n')}`);
  }
  assertLanesCoverModels(result.data);
  return result.data;
}

export function hashPrompt(text: string): string {
  return createHash('sha256').update(text).digest('hex').slice(0, 12);
}

export function readPromptFile(dir: string, name: PromptName): LoadedPrompt {
  const path = join(dir, `${name}.md`);
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (err) {
    throw new ConfigError(`Cannot read prompt ${path}: ${describe(err)}`);
  }
  // Normalize line endings and trailing whitespace so the version is stable across platforms.
  const text = stripBom(raw).replace(/\r\n/g, '\n').trimEnd();
  if (text.length === 0) throw new ConfigError(`Prompt ${path} is empty`);
  return { name, text, version: hashPrompt(text) };
}

export function createConfigService(options: ConfigServiceOptions): ConfigService {
  const { logger } = options;
  const configPath = options.configPath ?? DEFAULT_CONFIG_PATH;
  const promptsDir = options.promptsDir ?? DEFAULT_PROMPTS_DIR;
  const debounceMs = options.debounceMs ?? 500;

  const readConfigRaw = (): string => {
    try {
      return readFileSync(configPath, 'utf8');
    } catch (err) {
      throw new ConfigError(`Cannot read generation config ${configPath}: ${describe(err)}`);
    }
  };

  // Boot: any problem here is fatal.
  let lastRaw = readConfigRaw();
  let config = parseGenerationConfig(lastRaw);
  const prompts = new Map<PromptName, LoadedPrompt>();
  for (const name of PROMPT_NAMES) prompts.set(name, readPromptFile(promptsDir, name));

  const reloadConfig = (): string[] => {
    try {
      const raw = readConfigRaw();
      if (raw === lastRaw) return [];
      config = parseGenerationConfig(raw);
      lastRaw = raw;
      logger.info({ path: configPath }, 'generation config reloaded');
      return [];
    } catch (err) {
      logger.error({ err, path: configPath }, 'generation config rejected, keeping the last good config');
      return [describe(err)];
    }
  };

  const reloadPrompts = (): string[] => {
    const errors: string[] = [];
    for (const name of PROMPT_NAMES) {
      try {
        const next = readPromptFile(promptsDir, name);
        if (prompts.get(name)?.version !== next.version) {
          prompts.set(name, next);
          logger.info({ prompt: name, version: next.version }, 'prompt reloaded');
        }
      } catch (err) {
        logger.error({ err, prompt: name }, 'prompt rejected, keeping the last good version');
        errors.push(describe(err));
      }
    }
    return errors;
  };

  const reload = (): ReloadResult => {
    const errors = [...reloadConfig(), ...reloadPrompts()];
    return { ok: errors.length === 0, errors };
  };

  const watchers: FSWatcher[] = [];
  let timer: NodeJS.Timeout | undefined;
  const dirty = { config: false, prompts: false };

  const flush = (): void => {
    timer = undefined;
    if (dirty.config) reloadConfig();
    if (dirty.prompts) reloadPrompts();
    dirty.config = false;
    dirty.prompts = false;
  };

  const schedule = (): void => {
    if (timer !== undefined) clearTimeout(timer);
    timer = setTimeout(flush, debounceMs);
    timer.unref();
  };

  const watchDir = (dir: string, onFile: (filename: string | null) => void): void => {
    try {
      const watcher = watch(dir, { persistent: false }, (_event, filename) => onFile(filename));
      watcher.on('error', (err) => logger.error({ err, dir }, 'config watcher error'));
      watchers.push(watcher);
    } catch (err) {
      logger.error({ err, dir }, 'cannot watch config directory, hot reload disabled for it');
    }
  };

  if (options.watch !== false) {
    const configName = basename(configPath);
    watchDir(dirname(configPath), (filename) => {
      if (filename === null || filename === configName) {
        dirty.config = true;
        schedule();
      }
    });
    watchDir(promptsDir, (filename) => {
      if (filename === null || filename.endsWith('.md')) {
        dirty.prompts = true;
        schedule();
      }
    });
  }

  return {
    get: () => config,
    getPrompt(name) {
      const prompt = prompts.get(name);
      if (prompt === undefined) throw new ConfigError(`Prompt ${name} is not loaded`);
      return prompt;
    },
    getPromptVersions() {
      const version = (name: PromptName): string => prompts.get(name)?.version ?? '';
      return { planner: version('planner.system'), image: version('image.user'), video: version('video.user') };
    },
    reload,
    close() {
      if (timer !== undefined) clearTimeout(timer);
      timer = undefined;
      for (const watcher of watchers) watcher.close();
      watchers.length = 0;
    },
  };
}
