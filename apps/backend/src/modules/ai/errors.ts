import type { AiErrorKind } from '@rs/shared';
import type { ClassifiedError } from './index';
import { asList, asString, isRecord, parseJson, type JsonRecord } from './json';

// Provider error classification (SPEC 11.2). Everything is decided from the RAW response body:
// status, error.status, and the ErrorInfo, QuotaFailure and RetryInfo details. A persistent 429 is not
// always a rate limit (a depleted prepaid-credits balance is also a 429 RESOURCE_EXHAUSTED), so the
// HTTP code and message text alone are never trusted for 429s.

export const RAW_BODY_LIMIT = 4096;

// retryable means "another attempt later may succeed". The queue decides whether an attempt is consumed:
// transient and no_output consume one, the quota and availability kinds defer without consuming.
const RETRYABLE: Record<AiErrorKind, boolean> = {
  rate_limited: true,
  daily_quota: true,
  provider_unavailable: true,
  auth_error: true,
  transient: true,
  no_output: true,
  invalid_request: false,
  safety_blocked: false,
};

export function truncateBody(text: string): string {
  return text.length > RAW_BODY_LIMIT ? text.slice(0, RAW_BODY_LIMIT) : text;
}

export type AiErrorExtras = Partial<Omit<ClassifiedError, 'kind' | 'message' | 'retryable'>>;

export function makeAiError(kind: AiErrorKind, message: string, extras: AiErrorExtras = {}): ClassifiedError {
  return {
    kind,
    message: message.length > 500 ? `${message.slice(0, 500)}...` : message,
    httpStatus: extras.httpStatus ?? null,
    providerStatus: extras.providerStatus ?? null,
    providerReason: extras.providerReason ?? null,
    retryDelayMs: extras.retryDelayMs ?? null,
    rawBody: extras.rawBody === undefined || extras.rawBody === null ? null : truncateBody(extras.rawBody),
    retryable: RETRYABLE[kind],
  };
}

// RetryInfo.retryDelay is a protobuf Duration: "12s", "1.5s", or occasionally {seconds, nanos}.
export function parseRetryDelayMs(value: unknown): number | null {
  if (typeof value === 'string') {
    const match = /^\s*(\d+(?:\.\d+)?)\s*(ms|s)?\s*$/i.exec(value);
    if (match === null) return null;
    const amount = Number(match[1]);
    return Math.ceil(match[2]?.toLowerCase() === 'ms' ? amount : amount * 1000);
  }
  if (isRecord(value)) {
    const seconds = Number(value.seconds ?? 0);
    const nanos = Number(value.nanos ?? 0);
    if (!Number.isFinite(seconds) || !Number.isFinite(nanos)) return null;
    return Math.ceil(seconds * 1000 + nanos / 1e6);
  }
  return null;
}

interface ParsedGoogleError {
  code: number | null;
  status: string | null;
  message: string | null;
  // ErrorInfo.reason values, plus legacy error.errors[].reason.
  reasons: string[];
  // QuotaFailure violations and ErrorInfo quota metadata (quotaId, quotaMetric, quota_limit, quota_metric).
  quotaIds: string[];
  retryDelayMs: number | null;
}

const QUOTA_METADATA_KEYS = ['quota_limit', 'quotaLimit', 'quota_metric', 'quotaMetric', 'quota_id', 'quotaId'];

function readDetail(detail: JsonRecord, into: ParsedGoogleError): void {
  const type = asString(detail['@type']) ?? '';
  if (type.endsWith('ErrorInfo')) {
    const reason = asString(detail.reason);
    if (reason !== null) into.reasons.push(reason);
    const metadata = detail.metadata;
    if (isRecord(metadata)) {
      for (const key of QUOTA_METADATA_KEYS) {
        const value = asString(metadata[key]);
        if (value !== null) into.quotaIds.push(value);
      }
    }
  } else if (type.endsWith('QuotaFailure')) {
    for (const violation of asList(detail.violations)) {
      if (!isRecord(violation)) continue;
      for (const key of ['quotaId', 'quotaMetric']) {
        const value = asString(violation[key]);
        if (value !== null) into.quotaIds.push(value);
      }
    }
  } else if (type.endsWith('RetryInfo')) {
    into.retryDelayMs = parseRetryDelayMs(detail.retryDelay) ?? into.retryDelayMs;
  }
}

function parseGoogleError(rawBody: string): ParsedGoogleError | null {
  const parsed = parseJson(rawBody);
  if (!parsed.ok) return null;
  const root = Array.isArray(parsed.value) ? parsed.value[0] : parsed.value;
  if (!isRecord(root)) return null;
  const error = root.error;
  const result: ParsedGoogleError = { code: null, status: null, message: null, reasons: [], quotaIds: [], retryDelayMs: null };
  if (typeof error === 'string') {
    result.message = error;
    return result;
  }
  if (!isRecord(error)) return null;
  result.code = typeof error.code === 'number' ? error.code : null;
  result.status = asString(error.status);
  result.message = asString(error.message);
  for (const detail of asList(error.details)) if (isRecord(detail)) readDetail(detail, result);
  for (const legacy of asList(error.errors)) {
    if (!isRecord(legacy)) continue;
    const reason = asString(legacy.reason);
    if (reason !== null) result.reasons.push(reason);
  }
  return result;
}

// Billing disabled, prepaid credits depleted, API not enabled, unsupported location. None of these are
// fixed by waiting a minute, so they must never look like rate limits. The billing patterns are specific
// on purpose: the ordinary per-day 429 message says "check your plan and billing details".
const UNAVAILABLE_REASONS = new Set([
  'BILLING_DISABLED',
  'SERVICE_DISABLED',
  'ACCOUNT_STATE_INVALID',
  'CONSUMER_SUSPENDED',
  'PROJECT_DELETED',
  'CONSUMER_INVALID',
]);

const UNAVAILABLE_MESSAGE = [
  /prepay|prepaid/i,
  /credits?\s+(?:are|is|have been|has been)\s+(?:depleted|exhausted)|out of credits|insufficient credits/i,
  /billing\s+(?:is\s+)?(?:not\s+(?:enabled|active|set up)|disabled)|requires billing|enable billing|billing account[^.]{0,60}(?:not found|closed|disabled|inactive)/i,
  /has not been used in project|api (?:is )?not enabled|it is disabled|has been disabled|service[_ ]disabled/i,
  /user location is not supported/i,
];

const AUTH_REASON = /^(?:API_KEY_|ACCESS_TOKEN_|CREDENTIALS_|IAM_PERMISSION|AUTH_PERMISSION|USER_PROJECT_DENIED|SERVICE_ACCOUNT)/;
const AUTH_MESSAGE = /api key (?:not valid|expired|was reported as leaked)|invalid api key|unregistered callers|invalid authentication credentials|permission .{0,80} denied/i;

// Vertex and Veo report Responsible AI blocks as 400 INVALID_ARGUMENT with a human message and support codes.
const RAI_MESSAGE =
  /responsible ai|sensitive words|support codes?|safety (?:filter|setting)s?|violat\w+ .{0,60}(?:polic|guideline)|content (?:polic|filter)|(?:was|were|been) (?:blocked|filtered)/i;

const MODEL_NOT_FOUND = /publisher model|models\/[^\s]+ is not found|model [^.]{0,80}(?:not found|does not exist)/i;
const TRANSIENT_STATUSES = new Set(['UNAVAILABLE', 'DEADLINE_EXCEEDED', 'INTERNAL', 'ABORTED', 'CANCELLED', 'UNKNOWN']);

function messageRetryDelayMs(message: string | null): number | null {
  if (message === null) return null;
  const match = /(?:retry|try again) (?:in|after) (\d+(?:\.\d+)?)\s*(?:s|sec|seconds)\b/i.exec(message);
  return match === null ? null : Math.ceil(Number(match[1]) * 1000);
}

function retryAfterHeaderMs(value: string | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  const seconds = Number(value);
  return Number.isFinite(seconds) && seconds >= 0 ? Math.ceil(seconds * 1000) : null;
}

function decideKind(status: number, error: ParsedGoogleError | null): AiErrorKind {
  const message = error?.message ?? '';
  const reasons = error?.reasons ?? [];
  const providerStatus = error?.status ?? null;

  if (reasons.some((reason) => UNAVAILABLE_REASONS.has(reason)) || UNAVAILABLE_MESSAGE.some((re) => re.test(message))) {
    return 'provider_unavailable';
  }
  if (
    status === 401 ||
    providerStatus === 'UNAUTHENTICATED' ||
    reasons.some((reason) => AUTH_REASON.test(reason)) ||
    AUTH_MESSAGE.test(message)
  ) {
    return 'auth_error';
  }
  if (status === 429 || providerStatus === 'RESOURCE_EXHAUSTED') {
    const daily = (error?.quotaIds ?? []).some((id) => /day/i.test(id)) || /\b(?:per day|daily)\b/i.test(message);
    return daily ? 'daily_quota' : 'rate_limited';
  }
  if (status === 403 || providerStatus === 'PERMISSION_DENIED') return 'auth_error';
  if (status === 402 || providerStatus === 'FAILED_PRECONDITION') return 'provider_unavailable';
  if (status === 404 || providerStatus === 'NOT_FOUND') {
    return MODEL_NOT_FOUND.test(message) ? 'provider_unavailable' : 'invalid_request';
  }
  if (status === 400 || providerStatus === 'INVALID_ARGUMENT') {
    return RAI_MESSAGE.test(message) ? 'safety_blocked' : 'invalid_request';
  }
  if (status >= 500 || status === 408 || status === 409 || (providerStatus !== null && TRANSIENT_STATUSES.has(providerStatus))) {
    return 'transient';
  }
  return status >= 400 && status < 500 ? 'invalid_request' : 'transient';
}

export interface ClassifyOptions {
  // Value of the Retry-After response header, if the adapter has it.
  retryAfter?: string | null;
}

// Classifies a non-2xx provider response. rawBody is the response text exactly as received.
export function classifyAiError(status: number, rawBody: string, options: ClassifyOptions = {}): ClassifiedError {
  const error = parseGoogleError(rawBody);
  const kind = decideKind(status, error);
  const providerStatus = error?.status ?? null;
  const providerReason = error?.reasons[0] ?? error?.quotaIds[0] ?? null;
  const detail = error?.message ?? (rawBody.trim().length > 0 ? rawBody.trim() : 'no response body');
  const label = providerStatus === null ? `HTTP ${status}` : `HTTP ${status} ${providerStatus}`;
  return makeAiError(kind, `${label}: ${detail}`, {
    httpStatus: status,
    providerStatus,
    providerReason,
    retryDelayMs: error?.retryDelayMs ?? messageRetryDelayMs(error?.message ?? null) ?? retryAfterHeaderMs(options.retryAfter),
    rawBody,
  });
}

// Maps gRPC status codes carried inside a finished long-running operation's error field.
const GRPC_TO_STATUS: Record<number, { status: string; http: number }> = {
  1: { status: 'CANCELLED', http: 499 },
  2: { status: 'UNKNOWN', http: 500 },
  3: { status: 'INVALID_ARGUMENT', http: 400 },
  4: { status: 'DEADLINE_EXCEEDED', http: 504 },
  5: { status: 'NOT_FOUND', http: 404 },
  7: { status: 'PERMISSION_DENIED', http: 403 },
  8: { status: 'RESOURCE_EXHAUSTED', http: 429 },
  9: { status: 'FAILED_PRECONDITION', http: 400 },
  10: { status: 'ABORTED', http: 409 },
  13: { status: 'INTERNAL', http: 500 },
  14: { status: 'UNAVAILABLE', http: 503 },
  16: { status: 'UNAUTHENTICATED', http: 401 },
};

// A done operation can carry google.rpc.Status (code is a gRPC code, not an HTTP code). It is re-expressed
// as an HTTP-style error body so the same classifier applies.
export function classifyOperationError(operationError: unknown): ClassifiedError {
  const error = isRecord(operationError) ? operationError : {};
  const grpc = typeof error.code === 'number' ? GRPC_TO_STATUS[error.code] : undefined;
  const status = grpc?.http ?? 500;
  const body = { error: { ...error, code: status, status: asString(error.status) ?? grpc?.status } };
  return classifyAiError(status, JSON.stringify(body));
}

export function classifyTransportError(err: unknown, signal?: AbortSignal): ClassifiedError {
  const name = err instanceof Error ? err.name : '';
  if (name === 'AbortError' || name === 'TimeoutError' || signal?.aborted === true) {
    return makeAiError('transient', 'Request timed out or was aborted', { providerReason: 'timeout' });
  }
  const cause = err instanceof Error && err.cause instanceof Error ? ` (${err.cause.message})` : '';
  const message = err instanceof Error ? err.message : String(err);
  return makeAiError('transient', `Network error: ${message}${cause}`, { providerReason: 'network_error' });
}
