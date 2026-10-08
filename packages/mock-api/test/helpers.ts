import { expect, vi } from 'vitest';
import { ApiError, ERROR_HTTP_STATUS, errorEnvelopeSchema, type Api, type ErrorCode } from '@rs/shared';
import { createMockApi, resetMockApi } from '../src';

export const T0 = new Date('2026-03-01T12:00:00.000Z');

// A fresh mock store, a frozen clock that only moves with advance(), and no call latency.
export function freshApi(): Api {
  vi.useFakeTimers();
  vi.setSystemTime(T0);
  resetMockApi();
  return createMockApi({ latencyMs: 0 });
}

export function advance(ms: number): void {
  vi.advanceTimersByTime(ms);
}

export function cleanup(): void {
  vi.useRealTimers();
  resetMockApi();
}

// Rejects with an ApiError whose status matches the shared table and whose envelope validates.
export async function expectApiError(promise: Promise<unknown>, code: ErrorCode): Promise<ApiError> {
  const error: unknown = await promise.then(
    () => undefined,
    (err: unknown) => err,
  );
  expect(error).toBeInstanceOf(ApiError);
  const apiError = error as ApiError;
  expect(apiError.code).toBe(code);
  expect(apiError.status).toBe(ERROR_HTTP_STATUS[code]);
  const envelope = { error: { code: apiError.code, message: apiError.message, details: apiError.details } };
  expect(errorEnvelopeSchema.safeParse(envelope).success).toBe(true);
  return apiError;
}
