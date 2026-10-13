import { ApiError, ERROR_CODES, type ApiErrorCode } from '@rs/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { errorMessage, unresolvedProductGids, validationErrors } from './errors';

afterEach(() => vi.unstubAllGlobals());

const error = (code: ApiErrorCode, message = 'server text', details?: unknown) => new ApiError(0, code, message, details);

describe('errorMessage', () => {
  it('falls back for anything that is not an ApiError', () => {
    expect(errorMessage(new Error('x'))).toBe('Something went wrong. Try again.');
    expect(errorMessage(null, 'Could not load.')).toBe('Could not load.');
  });

  it('says the connection failed, or that the browser is offline', () => {
    expect(errorMessage(error('network_error'))).toBe('Cannot reach the server. Check your connection and try again.');
    vi.stubGlobal('navigator', { onLine: false });
    expect(errorMessage(error('network_error'))).toMatch(/^You are offline\./);
    vi.stubGlobal('navigator', { onLine: true });
    expect(errorMessage(error('network_error'))).toMatch(/^Cannot reach the server/);
  });

  it('explains a timeout and an unavailable service', () => {
    expect(errorMessage(error('timeout'))).toBe('The server took too long to answer. Try again.');
    expect(errorMessage(error('service_unavailable'))).toBe(
      'The service is busy or temporarily down. Try again in a moment.',
    );
  });

  it('asks to wait after too many requests, for as long as the server said', () => {
    expect(errorMessage(error('too_many_requests'))).toBe('Too many requests. Wait a moment and try again.');
    expect(errorMessage(error('too_many_requests', 'x', { retryAfterSec: 1 }))).toBe(
      'Too many requests. Wait 1 second and try again.',
    );
    expect(errorMessage(error('too_many_requests', 'x', { retryAfterSec: 12.2 }))).toBe(
      'Too many requests. Wait 13 seconds and try again.',
    );
    expect(errorMessage(error('too_many_requests', 'x', { retryAfterSec: 60 }))).toBe(
      'Too many requests. Wait 1 minute and try again.',
    );
    expect(errorMessage(error('too_many_requests', 'x', { retryAfterSec: 150 }))).toBe(
      'Too many requests. Wait 3 minutes and try again.',
    );
  });

  it('keeps the server text of the errors the merchant can act on', () => {
    for (const code of ['shop_limit', 'in_use', 'not_found', 'validation_failed'] as const) {
      expect(errorMessage(error(code, 'Server says so'))).toBe('Server says so');
    }
  });

  it('uses the fallback for errors the merchant cannot act on', () => {
    for (const code of ['forbidden', 'not_implemented', 'internal', 'invalid_response'] as const) {
      expect(errorMessage(error(code), 'Fallback.')).toBe('Fallback.');
    }
  });

  it('has a sentence for every error code', () => {
    const codes: ApiErrorCode[] = [...ERROR_CODES, 'network_error', 'timeout', 'service_unavailable', 'invalid_response'];
    for (const code of codes) expect(errorMessage(error(code), 'Fallback.')).not.toBe('');
  });
});

describe('validationErrors', () => {
  it('reads the list of a validation_failed error', () => {
    const errors = ['Missing required placeholder {{shot.prompt}}.', 'The prompt is too long.'];
    expect(validationErrors(error('validation_failed', 'x', { errors }))).toEqual(errors);
  });

  it('keeps only the non-empty strings of the list', () => {
    expect(validationErrors(error('validation_failed', 'x', { errors: ['a', 3, null, '  ', 'b'] }))).toEqual(['a', 'b']);
  });

  it('is null when there is no usable list', () => {
    expect(validationErrors(error('validation_failed'))).toBeNull();
    expect(validationErrors(error('validation_failed', 'x', 'garbage'))).toBeNull();
    expect(validationErrors(error('validation_failed', 'x', { errors: [] }))).toBeNull();
    expect(validationErrors(error('validation_failed', 'x', { errors: 'nope' }))).toBeNull();
    expect(validationErrors(error('validation_failed', 'x', { issues: [{ message: 'y' }] }))).toBeNull();
  });

  it('is null for any other error', () => {
    expect(validationErrors(error('shop_limit', 'x', { errors: ['a'] }))).toBeNull();
    expect(validationErrors(new Error('x'))).toBeNull();
    expect(validationErrors(undefined)).toBeNull();
  });
});

describe('unresolvedProductGids', () => {
  it('reads the gids of a references_required error and is null for anything else', () => {
    const gids = ['gid://shopify/Product/1'];
    expect(unresolvedProductGids(error('references_required', 'x', { productGids: gids }))).toEqual(gids);
    expect(unresolvedProductGids(error('references_required', 'x', 'garbage'))).toEqual([]);
    expect(unresolvedProductGids(error('internal'))).toBeNull();
    expect(unresolvedProductGids(new Error('x'))).toBeNull();
  });
});
