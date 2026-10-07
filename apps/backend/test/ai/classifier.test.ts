import { describe, expect, it } from 'vitest';
import type { AiErrorKind } from '@rs/shared';
import {
  RAW_BODY_LIMIT,
  classifyAiError,
  classifyOperationError,
  classifyTransportError,
  parseRetryDelayMs,
} from '../../src/modules/ai/errors';
import { fixtureText } from './helpers';

interface Case {
  fixture: string;
  status: number;
  kind: AiErrorKind;
  providerStatus: string | null;
  providerReason?: string | null;
  retryDelayMs?: number | null;
  retryable: boolean;
}

// Each fixture is a recorded-style raw response body. The expectations follow the SPEC 11.2 table.
const CASES: Case[] = [
  { fixture: '429-per-minute-retryinfo.json', status: 429, kind: 'rate_limited', providerStatus: 'RESOURCE_EXHAUSTED', providerReason: 'GenerateRequestsPerMinutePerProjectPerModel-FreeTier', retryDelayMs: 12000, retryable: true },
  { fixture: '429-per-day-aistudio.json', status: 429, kind: 'daily_quota', providerStatus: 'RESOURCE_EXHAUSTED', providerReason: 'GenerateRequestsPerDayPerProjectPerModel-FreeTier', retryDelayMs: 41000, retryable: true },
  { fixture: '429-per-minute-and-per-day.json', status: 429, kind: 'daily_quota', providerStatus: 'RESOURCE_EXHAUSTED', retryDelayMs: 3000, retryable: true },
  { fixture: '429-vertex-quota-per-minute-errorinfo.json', status: 429, kind: 'rate_limited', providerStatus: 'RESOURCE_EXHAUSTED', providerReason: 'RATE_LIMIT_EXCEEDED', retryDelayMs: null, retryable: true },
  { fixture: '429-vertex-quota-per-day-errorinfo.json', status: 429, kind: 'daily_quota', providerStatus: 'RESOURCE_EXHAUSTED', providerReason: 'RATE_LIMIT_EXCEEDED', retryable: true },
  { fixture: '429-vertex-dynamic-shared-quota.json', status: 429, kind: 'rate_limited', providerStatus: 'RESOURCE_EXHAUSTED', providerReason: null, retryDelayMs: null, retryable: true },
  { fixture: '429-prepay-credits-depleted.json', status: 429, kind: 'provider_unavailable', providerStatus: 'RESOURCE_EXHAUSTED', retryable: true },
  { fixture: '403-billing-disabled.json', status: 403, kind: 'provider_unavailable', providerStatus: 'PERMISSION_DENIED', providerReason: 'BILLING_DISABLED', retryable: true },
  { fixture: '403-api-not-enabled.json', status: 403, kind: 'provider_unavailable', providerStatus: 'PERMISSION_DENIED', providerReason: 'SERVICE_DISABLED', retryable: true },
  { fixture: '400-location-not-supported.json', status: 400, kind: 'provider_unavailable', providerStatus: 'FAILED_PRECONDITION', retryable: true },
  { fixture: '404-publisher-model-not-found.json', status: 404, kind: 'provider_unavailable', providerStatus: 'NOT_FOUND', retryable: true },
  { fixture: '401-unauthenticated.json', status: 401, kind: 'auth_error', providerStatus: 'UNAUTHENTICATED', providerReason: 'ACCESS_TOKEN_TYPE_UNSUPPORTED', retryable: true },
  { fixture: '403-iam-permission-denied.json', status: 403, kind: 'auth_error', providerStatus: 'PERMISSION_DENIED', providerReason: 'IAM_PERMISSION_DENIED', retryable: true },
  { fixture: '400-api-key-invalid.json', status: 400, kind: 'auth_error', providerStatus: 'INVALID_ARGUMENT', providerReason: 'API_KEY_INVALID', retryable: true },
  { fixture: '400-invalid-argument.json', status: 400, kind: 'invalid_request', providerStatus: 'INVALID_ARGUMENT', retryable: false },
  { fixture: '400-veo-rai-blocked.json', status: 400, kind: 'safety_blocked', providerStatus: 'INVALID_ARGUMENT', retryable: false },
  { fixture: '503-model-overloaded.json', status: 503, kind: 'transient', providerStatus: 'UNAVAILABLE', retryable: true },
  { fixture: '500-internal.json', status: 500, kind: 'transient', providerStatus: 'INTERNAL', retryable: true },
  { fixture: '504-deadline-exceeded.json', status: 504, kind: 'transient', providerStatus: 'DEADLINE_EXCEEDED', retryable: true },
];

describe('classifyAiError on recorded bodies', () => {
  it.each(CASES)('$fixture (HTTP $status) is $kind', (testCase) => {
    const body = fixtureText(testCase.fixture);
    const error = classifyAiError(testCase.status, body);
    expect(error.kind).toBe(testCase.kind);
    expect(error.httpStatus).toBe(testCase.status);
    expect(error.providerStatus).toBe(testCase.providerStatus);
    expect(error.retryable).toBe(testCase.retryable);
    expect(error.rawBody).toBe(body);
    if (testCase.providerReason !== undefined) expect(error.providerReason).toBe(testCase.providerReason);
    if (testCase.retryDelayMs !== undefined) expect(error.retryDelayMs).toBe(testCase.retryDelayMs);
  });

  it('never classifies a prepaid-credits 429 as rate_limited', () => {
    const error = classifyAiError(429, fixtureText('429-prepay-credits-depleted.json'));
    expect(error.kind).not.toBe('rate_limited');
    expect(error.kind).not.toBe('daily_quota');
    expect(error.kind).toBe('provider_unavailable');
    expect(error.message).toMatch(/prepayment credits are depleted/);
  });

  it('keeps a depleted-credits 429 provider_unavailable even without a status field or details', () => {
    const body = JSON.stringify({ error: { code: 429, message: 'Your prepayment credits are depleted.' } });
    expect(classifyAiError(429, body).kind).toBe('provider_unavailable');
  });

  it('does not read "billing details" in the ordinary quota message as a billing problem', () => {
    const error = classifyAiError(429, fixtureText('429-per-minute-retryinfo.json'));
    expect(error.message).toMatch(/billing details/);
    expect(error.kind).toBe('rate_limited');
  });

  it('classifies from the body, not the HTTP code: a 429 status with a billing reason is unavailable', () => {
    const body = JSON.stringify({
      error: {
        code: 429,
        message: 'Quota issue',
        status: 'RESOURCE_EXHAUSTED',
        details: [{ '@type': 'type.googleapis.com/google.rpc.ErrorInfo', reason: 'BILLING_DISABLED' }],
      },
    });
    expect(classifyAiError(429, body).kind).toBe('provider_unavailable');
  });

  it('treats RESOURCE_EXHAUSTED as a quota error even when the HTTP status is not 429', () => {
    const body = JSON.stringify({ error: { code: 429, message: 'x', status: 'RESOURCE_EXHAUSTED' } });
    expect(classifyAiError(200, body).kind).toBe('rate_limited');
  });

  it('detects a daily limit from the message when no quota details exist', () => {
    const body = JSON.stringify({ error: { code: 429, message: 'You exceeded your daily limit.', status: 'RESOURCE_EXHAUSTED' } });
    expect(classifyAiError(429, body).kind).toBe('daily_quota');
  });

  it('reads the retry delay from the message when RetryInfo is missing', () => {
    const body = JSON.stringify({ error: { code: 429, message: 'Quota exceeded. Please retry in 56.2s.', status: 'RESOURCE_EXHAUSTED' } });
    expect(classifyAiError(429, body).retryDelayMs).toBe(56200);
  });

  it('falls back to the Retry-After header', () => {
    const body = fixtureText('429-vertex-dynamic-shared-quota.json');
    expect(classifyAiError(429, body, { retryAfter: '7' }).retryDelayMs).toBe(7000);
    expect(classifyAiError(429, body, { retryAfter: 'Wed, 21 Oct 2026 07:28:00 GMT' }).retryDelayMs).toBeNull();
  });

  it('classifies non-JSON bodies by status', () => {
    expect(classifyAiError(502, '<html><body>Bad Gateway</body></html>').kind).toBe('transient');
    expect(classifyAiError(429, 'Too many requests').kind).toBe('rate_limited');
    expect(classifyAiError(500, '').kind).toBe('transient');
    expect(classifyAiError(401, '').kind).toBe('auth_error');
    expect(classifyAiError(400, 'bad').kind).toBe('invalid_request');
  });

  it('reads an error wrapped in an array, as streaming endpoints return', () => {
    const body = `[${fixtureText('503-model-overloaded.json')}]`;
    const error = classifyAiError(503, body);
    expect(error.kind).toBe('transient');
    expect(error.providerStatus).toBe('UNAVAILABLE');
  });

  it('truncates the raw body to 4 KB', () => {
    const body = JSON.stringify({ error: { code: 500, message: 'x'.repeat(10_000), status: 'INTERNAL' } });
    const error = classifyAiError(500, body);
    expect(error.rawBody).toHaveLength(RAW_BODY_LIMIT);
    expect(error.rawBody).toBe(body.slice(0, RAW_BODY_LIMIT));
    expect(error.message.length).toBeLessThanOrEqual(503);
  });
});

describe('parseRetryDelayMs', () => {
  it('parses protobuf durations', () => {
    expect(parseRetryDelayMs('12s')).toBe(12000);
    expect(parseRetryDelayMs('1.5s')).toBe(1500);
    expect(parseRetryDelayMs('0.25s')).toBe(250);
    expect(parseRetryDelayMs('41.2s')).toBe(41200);
    expect(parseRetryDelayMs('500ms')).toBe(500);
    expect(parseRetryDelayMs({ seconds: '3', nanos: 500_000_000 })).toBe(3500);
  });

  it('rejects anything else', () => {
    expect(parseRetryDelayMs('soon')).toBeNull();
    expect(parseRetryDelayMs('-5s')).toBeNull();
    expect(parseRetryDelayMs(null)).toBeNull();
    expect(parseRetryDelayMs(12)).toBeNull();
  });
});

describe('classifyOperationError', () => {
  it('maps a gRPC RESOURCE_EXHAUSTED operation error to a quota class', () => {
    const error = classifyOperationError({ code: 8, message: 'Quota exceeded for veo per day', details: [] });
    expect(error.kind).toBe('daily_quota');
    expect(error.providerStatus).toBe('RESOURCE_EXHAUSTED');
  });

  it('maps a gRPC INVALID_ARGUMENT Responsible AI error to safety_blocked', () => {
    const error = classifyOperationError({
      code: 3,
      message: "Video generation failed: the output violates Google's Responsible AI practices. Support codes: 11111111",
    });
    expect(error.kind).toBe('safety_blocked');
  });

  it('maps UNAVAILABLE and unknown codes to transient', () => {
    expect(classifyOperationError({ code: 14, message: 'try later' }).kind).toBe('transient');
    expect(classifyOperationError({ message: 'weird' }).kind).toBe('transient');
    expect(classifyOperationError('nonsense').kind).toBe('transient');
  });
});

describe('classifyTransportError', () => {
  it('maps aborts and timeouts to transient with reason timeout', () => {
    const abort = classifyTransportError(new DOMException('Aborted', 'AbortError'));
    expect(abort).toMatchObject({ kind: 'transient', providerReason: 'timeout', httpStatus: null, retryable: true });
    const timeout = classifyTransportError(new DOMException('Timed out', 'TimeoutError'));
    expect(timeout.providerReason).toBe('timeout');
    const controller = new AbortController();
    controller.abort();
    expect(classifyTransportError(new Error('whatever'), controller.signal).providerReason).toBe('timeout');
  });

  it('maps network failures to transient with reason network_error', () => {
    const err = new TypeError('fetch failed', { cause: new Error('connect ECONNRESET') });
    const error = classifyTransportError(err);
    expect(error).toMatchObject({ kind: 'transient', providerReason: 'network_error' });
    expect(error.message).toMatch(/ECONNRESET/);
  });
});
