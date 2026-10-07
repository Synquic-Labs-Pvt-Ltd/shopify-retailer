import type { AiProviderName } from '@rs/shared';
import type { Logger } from '../../core/logger';
import type { AiResult, ClassifiedError } from './index';
import { classifyAiError, classifyTransportError, makeAiError } from './errors';
import { parseJson } from './json';

// Provider HTTP plumbing. API failures never throw: transport errors and non-2xx responses come back as
// an AiResult error classified from the raw body, and every non-2xx body is logged.

export interface HttpContext {
  provider: AiProviderName;
  fetchImpl: typeof fetch;
  logger: Logger;
}

export interface HttpRequest {
  // Short name for logs, for example "vertex.generateContent".
  op: string;
  url: string;
  method?: 'GET' | 'POST';
  headers: Record<string, string>;
  body?: unknown;
  signal: AbortSignal;
}

const LOG_BODY_LIMIT = 16384;

// Logs at error level for classes that need an operator (credentials, billing, bad request), warn otherwise.
function logFailure(ctx: HttpContext, request: HttpRequest, status: number, body: string, error: ClassifiedError): void {
  const fields = {
    provider: ctx.provider,
    op: request.op,
    status,
    kind: error.kind,
    providerStatus: error.providerStatus,
    providerReason: error.providerReason,
    body: body.length > LOG_BODY_LIMIT ? body.slice(0, LOG_BODY_LIMIT) : body,
  };
  const needsOperator = error.kind === 'provider_unavailable' || error.kind === 'auth_error' || error.kind === 'invalid_request';
  if (needsOperator) ctx.logger.error(fields, 'ai provider call failed');
  else ctx.logger.warn(fields, 'ai provider call failed');
}

async function send(ctx: HttpContext, request: HttpRequest): Promise<AiResult<Response>> {
  try {
    const hasBody = request.body !== undefined;
    const response = await ctx.fetchImpl(request.url, {
      method: request.method ?? (hasBody ? 'POST' : 'GET'),
      headers: request.headers,
      body: hasBody ? JSON.stringify(request.body) : undefined,
      signal: request.signal,
    });
    return { ok: true, value: response };
  } catch (err) {
    const error = classifyTransportError(err, request.signal);
    ctx.logger.warn({ provider: ctx.provider, op: request.op, kind: error.kind, reason: error.providerReason }, 'ai provider transport error');
    return { ok: false, error };
  }
}

async function readFailure(ctx: HttpContext, request: HttpRequest, response: Response): Promise<ClassifiedError> {
  let body: string;
  try {
    body = await response.text();
  } catch (err) {
    return classifyTransportError(err, request.signal);
  }
  const error = classifyAiError(response.status, body, { retryAfter: response.headers.get('retry-after') });
  logFailure(ctx, request, response.status, body, error);
  return error;
}

export async function requestJson(ctx: HttpContext, request: HttpRequest): Promise<AiResult<unknown>> {
  const sent = await send(ctx, request);
  if (!sent.ok) return sent;
  const response = sent.value;
  if (!response.ok) return { ok: false, error: await readFailure(ctx, request, response) };
  let text: string;
  try {
    text = await response.text();
  } catch (err) {
    return { ok: false, error: classifyTransportError(err, request.signal) };
  }
  const parsed = parseJson(text);
  if (!parsed.ok) {
    const error = makeAiError('transient', `HTTP ${response.status} response body is not valid JSON`, {
      httpStatus: response.status,
      rawBody: text,
    });
    logFailure(ctx, request, response.status, text, error);
    return { ok: false, error };
  }
  return { ok: true, value: parsed.value };
}

export interface BinaryResponse {
  bytes: Uint8Array;
  contentType: string | null;
}

export async function requestBytes(ctx: HttpContext, request: HttpRequest): Promise<AiResult<BinaryResponse>> {
  const sent = await send(ctx, request);
  if (!sent.ok) return sent;
  const response = sent.value;
  if (!response.ok) return { ok: false, error: await readFailure(ctx, request, response) };
  try {
    const bytes = new Uint8Array(await response.arrayBuffer());
    const contentType = response.headers.get('content-type')?.split(';')[0]?.trim() ?? null;
    return { ok: true, value: { bytes, contentType } };
  } catch (err) {
    return { ok: false, error: classifyTransportError(err, request.signal) };
  }
}
