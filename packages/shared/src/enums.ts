// Every enum from SPEC sections 8.4, 11.2, 13, 14 and 15.
// Each enum is a readonly tuple (usable with z.enum and mongoose) plus a union type.

export const SHOP_STATUSES = ['active', 'uninstalled', 'reauth_required'] as const;
export type ShopStatus = (typeof SHOP_STATUSES)[number];

export const SESSION_PLATFORMS = ['android', 'ios'] as const;
export type SessionPlatform = (typeof SESSION_PLATFORMS)[number];

export const OAUTH_PHASES = ['offline', 'online'] as const;
export type OauthPhase = (typeof OAUTH_PHASES)[number];

export const WEBHOOK_TOPICS = [
  'app/uninstalled',
  'customers/data_request',
  'customers/redact',
  'shop/redact',
] as const;
export type WebhookTopic = (typeof WEBHOOK_TOPICS)[number];

export const MEDIA_ROLES = ['reference', 'output'] as const;
export type MediaRole = (typeof MEDIA_ROLES)[number];

export const MEDIA_TYPES = ['image', 'video'] as const;
export type MediaType = (typeof MEDIA_TYPES)[number];

export const STORAGE_PROVIDERS = ['shopify', 's3'] as const;
export type StorageProvider = (typeof STORAGE_PROVIDERS)[number];

export const MEDIA_STATUSES = ['awaiting_upload', 'processing', 'ready', 'failed', 'deleted'] as const;
export type MediaStatus = (typeof MEDIA_STATUSES)[number];

export const MEDIA_SCOPES = ['common', 'product'] as const;
export type MediaScope = (typeof MEDIA_SCOPES)[number];

export const BATCH_STATUSES = [
  'queued',
  'running',
  'completed',
  'completed_with_errors',
  'failed',
  'cancelled',
] as const;
export type BatchStatus = (typeof BATCH_STATUSES)[number];
export const TERMINAL_BATCH_STATUSES = ['completed', 'completed_with_errors', 'failed', 'cancelled'] as const;

export function isTerminalBatchStatus(status: BatchStatus): boolean {
  return (TERMINAL_BATCH_STATUSES as readonly string[]).includes(status);
}

// Persisted per batch item (SPEC 14.8).
export const REFERENCE_MODES = ['own_plus_common', 'own_only', 'common_only'] as const;
export type ReferenceMode = (typeof REFERENCE_MODES)[number];

// Live resolution result (SPEC 9): the persisted modes plus "none" for an unresolved product.
export const REFERENCE_RESOLUTIONS = [...REFERENCE_MODES, 'none'] as const;
export type ReferenceResolution = (typeof REFERENCE_RESOLUTIONS)[number];

export const ITEM_STATUSES = [
  'pending',
  'planning',
  'generating',
  'completed',
  'partial',
  'failed',
  'cancelled',
] as const;
export type ItemStatus = (typeof ITEM_STATUSES)[number];

export const PLAN_SOURCES = ['planner', 'fallback'] as const;
export type PlanSource = (typeof PLAN_SOURCES)[number];

export const JOB_TYPES = ['plan', 'image', 'video'] as const;
export type JobType = (typeof JOB_TYPES)[number];

export const JOB_STATUSES = [
  'blocked',
  'queued',
  'running',
  'awaiting_operation',
  'succeeded',
  'failed',
  'cancelled',
] as const;
export type JobStatus = (typeof JOB_STATUSES)[number];
export const TERMINAL_JOB_STATUSES = ['succeeded', 'failed', 'cancelled'] as const;

export function isTerminalJobStatus(status: JobStatus): boolean {
  return (TERMINAL_JOB_STATUSES as readonly string[]).includes(status);
}

export const JOB_ERROR_CODES = [
  'rate_limited',
  'daily_quota',
  'provider_unavailable',
  'auth_error',
  'transient',
  'invalid_request',
  'safety_blocked',
  'no_output',
  'timeout',
  'lease_expired',
  'quota_timeout',
  'shopify_upload_failed',
  'cancelled',
  'internal',
] as const;
export type JobErrorCode = (typeof JOB_ERROR_CODES)[number];

// Provider error classes produced by the ai module (SPEC 11.2 table); a subset of JobErrorCode.
export const AI_ERROR_KINDS = [
  'rate_limited',
  'daily_quota',
  'provider_unavailable',
  'auth_error',
  'transient',
  'invalid_request',
  'safety_blocked',
  'no_output',
] as const;
export type AiErrorKind = (typeof AI_ERROR_KINDS)[number];

export const LANE_PAUSE_REASONS = ['rate_limited', 'daily_quota', 'provider_unavailable', 'auth_error'] as const;
export type LanePauseReason = (typeof LANE_PAUSE_REASONS)[number];

export const RATE_WINDOWS = ['minute', 'hour', 'day'] as const;
export type RateWindow = (typeof RATE_WINDOWS)[number];

// Generation config enums (SPEC 13).
export const AI_PROVIDERS = ['vertex', 'aistudio', 'fake'] as const;
export type AiProviderName = (typeof AI_PROVIDERS)[number];

export const IMAGE_SIZES = ['1K', '2K', '4K'] as const;
export type ImageSize = (typeof IMAGE_SIZES)[number];

export const IMAGE_OUTPUT_MIME_TYPES = ['image/jpeg', 'image/png'] as const;
export type ImageOutputMimeType = (typeof IMAGE_OUTPUT_MIME_TYPES)[number];

export const VIDEO_ASPECT_RATIOS = ['9:16', '16:9'] as const;
export type VideoAspectRatio = (typeof VIDEO_ASPECT_RATIOS)[number];

export const VIDEO_RESOLUTIONS = ['720p', '1080p'] as const;
export type VideoResolution = (typeof VIDEO_RESOLUTIONS)[number];

export const PERSON_GENERATION_MODES = ['allow_adult', 'dont_allow'] as const;
export type PersonGenerationMode = (typeof PERSON_GENERATION_MODES)[number];

// Shopify Admin GraphQL ProductStatus values, passed through unchanged (SPEC 8.5).
export const PRODUCT_STATUSES = ['ACTIVE', 'ARCHIVED', 'DRAFT', 'UNLISTED'] as const;
export type ProductStatus = (typeof PRODUCT_STATUSES)[number];

// API error envelope codes (SPEC 15) plus in_use (DELETE /media/:id), not_implemented (S3 stub, SPEC 8.6)
// and too_many_requests (express-rate-limit, SPEC 18).
export const ERROR_CODES = [
  'unauthorized',
  'forbidden',
  'not_found',
  'validation_failed',
  'references_required',
  'shop_limit',
  'shop_reauth_required',
  'in_use',
  'not_implemented',
  'too_many_requests',
  'internal',
] as const;
export type ErrorCode = (typeof ERROR_CODES)[number];

export const ERROR_HTTP_STATUS: Record<ErrorCode, number> = {
  unauthorized: 401,
  forbidden: 403,
  not_found: 404,
  validation_failed: 400,
  references_required: 422,
  shop_limit: 429,
  shop_reauth_required: 409,
  in_use: 409,
  not_implemented: 501,
  too_many_requests: 429,
  internal: 500,
};

// Mongoose connection states reported by GET /health.
export const DB_STATES = ['disconnected', 'connected', 'connecting', 'disconnecting', 'uninitialized'] as const;
export type DbState = (typeof DB_STATES)[number];
