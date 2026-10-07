import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { pino } from 'pino';
import { defaultGenerationConfig, type GenerationConfig } from '@rs/shared';
import type { Logger } from '../../src/core/logger';
import type { HttpContext } from '../../src/modules/ai/http';
import type { AiProviderName } from '@rs/shared';

const FIXTURE_DIR = fileURLToPath(new URL('../../fixtures/ai-errors/', import.meta.url));

export function fixtureText(name: string): string {
  return readFileSync(join(FIXTURE_DIR, name), 'utf8');
}

export function fixtureJson(name: string): unknown {
  return JSON.parse(fixtureText(name)) as unknown;
}

export interface RecordedCall {
  url: string;
  method: string;
  headers: Record<string, string>;
  // Parsed JSON request body, or undefined when there is none.
  body: unknown;
}

export type Responder = (call: RecordedCall, index: number) => Response | Promise<Response>;

// A fetch replacement that records every request and answers from `respond`. It honours abort signals.
export function recordingFetch(respond: Responder): { fetchImpl: typeof fetch; calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  const fetchImpl = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    if (init?.signal?.aborted === true) throw init.signal.reason;
    const headers: Record<string, string> = {};
    for (const [key, value] of Object.entries((init?.headers ?? {}) as Record<string, string>)) headers[key.toLowerCase()] = value;
    const call: RecordedCall = {
      url: typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url,
      method: init?.method ?? 'GET',
      headers,
      body: typeof init?.body === 'string' ? (JSON.parse(init.body) as unknown) : undefined,
    };
    calls.push(call);
    return respond(call, calls.length - 1);
  };
  return { fetchImpl, calls };
}

export function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(typeof body === 'string' ? body : JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

export interface LogCapture {
  logger: Logger;
  lines: Record<string, unknown>[];
}

export function captureLogger(): LogCapture {
  const lines: Record<string, unknown>[] = [];
  const logger = pino({ level: 'debug' }, { write: (chunk: string) => void lines.push(JSON.parse(chunk) as Record<string, unknown>) });
  return { logger, lines };
}

export function httpContext(provider: AiProviderName, fetchImpl: typeof fetch, logger = captureLogger().logger): HttpContext {
  return { provider, fetchImpl, logger };
}

export function testConfig(overrides: Partial<GenerationConfig> = {}): GenerationConfig {
  return { ...defaultGenerationConfig, ...overrides };
}

export function signal(): AbortSignal {
  return new AbortController().signal;
}

export function bytes(...values: number[]): Uint8Array {
  return new Uint8Array(values);
}

export function b64(data: Uint8Array): string {
  return Buffer.from(data).toString('base64');
}

// Reads a nested value from parsed JSON without casts: at(body, 'a', 0, 'b').
export function at(value: unknown, ...path: (string | number)[]): unknown {
  let current: unknown = value;
  for (const key of path) {
    if (typeof current !== 'object' || current === null) return undefined;
    current = (current as Record<string | number, unknown>)[key];
  }
  return current;
}
