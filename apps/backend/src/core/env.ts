import { existsSync } from 'node:fs';
import { z } from 'zod';
import { LOG_LEVELS } from './logger';

export const SERVER_ROLES = ['api', 'worker', 'all'] as const;
export type ServerRole = (typeof SERVER_ROLES)[number];

// Development-only defaults. Production refuses to start with any of these values.
export const DEV_DEFAULTS = {
  JWT_SECRET: 'dev-only-jwt-secret-do-not-use-in-production-0000',
  TOKEN_ENC_KEY: '00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff',
  SHOPIFY_API_KEY: 'dev-shopify-api-key',
  SHOPIFY_API_SECRET: 'dev-shopify-api-secret',
} as const;

const DEV_PUBLIC_BASE_URL = 'http://localhost:3000';

// 32 bytes, as 64 hex characters or standard base64 (44 characters with one "=").
function isValidEncKey(value: string): boolean {
  return /^[0-9a-fA-F]{64}$/.test(value) || /^[A-Za-z0-9+/]{43}=$/.test(value);
}

function splitList(value: string): string[] {
  return value
    .split(',')
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

const nonEmpty = z.string().trim().min(1);

const envSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    PORT: z.coerce.number().int().min(1).max(65535).default(3000),
    ROLE: z.enum(SERVER_ROLES).default('all'),
    PUBLIC_BASE_URL: z
      .url()
      .default(DEV_PUBLIC_BASE_URL)
      .transform((url) => url.replace(/\/+$/, '')),
    MONGODB_URI: z
      .string()
      .regex(/^mongodb(\+srv)?:\/\//, 'must start with mongodb:// or mongodb+srv://')
      .default('mongodb://127.0.0.1:27017/retailer-studio'),
    JWT_SECRET: z.string().min(32, 'must be at least 32 characters').default(DEV_DEFAULTS.JWT_SECRET),
    TOKEN_ENC_KEY: z
      .string()
      .refine(isValidEncKey, 'must be 32 bytes as 64 hex characters or base64')
      .default(DEV_DEFAULTS.TOKEN_ENC_KEY),
    SHOPIFY_API_KEY: nonEmpty.default(DEV_DEFAULTS.SHOPIFY_API_KEY),
    SHOPIFY_API_SECRET: nonEmpty.default(DEV_DEFAULTS.SHOPIFY_API_SECRET),
    SHOPIFY_SCOPES: z.string().default('read_products,read_files,write_files').transform(splitList),
    SHOPIFY_API_VERSION: z
      .string()
      .regex(/^\d{4}-\d{2}$/, 'must look like 2026-10')
      .default('2026-10'),
    APP_DEEP_LINK_SCHEME: z
      .string()
      .regex(/^[a-z][a-z0-9+.-]*$/, 'must be a lowercase URL scheme')
      .default('retailerstudio'),
    GOOGLE_CLOUD_PROJECT: nonEmpty.optional(),
    GOOGLE_APPLICATION_CREDENTIALS: nonEmpty.optional(),
    GEMINI_API_KEY: nonEmpty.optional(),
    GENERATION_CONFIG_PATH: nonEmpty.optional(),
    LOG_LEVEL: z.enum(LOG_LEVELS).default('info'),
  })
  .superRefine((env, ctx) => {
    if (env.NODE_ENV !== 'production') return;
    if (!env.PUBLIC_BASE_URL.startsWith('https://')) {
      ctx.addIssue({
        code: 'custom',
        message: 'must be an https URL in production',
        path: ['PUBLIC_BASE_URL'],
      });
    }
    for (const key of Object.keys(DEV_DEFAULTS) as (keyof typeof DEV_DEFAULTS)[]) {
      if (env[key] === DEV_DEFAULTS[key]) {
        ctx.addIssue({
          code: 'custom',
          message: 'is required in production (the development default is not allowed)',
          path: [key],
        });
      }
    }
  });

export type Env = z.output<typeof envSchema>;

export class EnvValidationError extends Error {
  readonly issues: string[];

  constructor(issues: string[]) {
    super(`Invalid environment configuration:\n${issues.map((issue) => `  - ${issue}`).join('\n')}`);
    this.name = 'EnvValidationError';
    this.issues = issues;
  }
}

// Empty strings (for example "GEMINI_API_KEY=" in .env) count as unset.
export function parseEnv(source: Record<string, string | undefined> = process.env): Env {
  const cleaned: Record<string, string> = {};
  for (const [key, value] of Object.entries(source)) {
    if (value !== undefined && value !== '') cleaned[key] = value;
  }
  const result = envSchema.safeParse(cleaned);
  if (!result.success) {
    throw new EnvValidationError(
      result.error.issues.map((issue) => `${issue.path.map(String).join('.') || '(root)'}: ${issue.message}`),
    );
  }
  return result.data;
}

// Loads .env into process.env without overriding variables that are already set.
export function loadDotEnv(path = '.env'): void {
  if (existsSync(path)) process.loadEnvFile(path);
}
