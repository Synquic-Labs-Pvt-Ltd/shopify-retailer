import { randomUUID } from 'node:crypto';
import type { RequestHandler } from 'express';
import type { ZodType } from 'zod';
import { zodErrorToAppError } from './errors';
import type { Logger } from './logger';

// Parses untrusted input with a shared schema; throws a validation_failed AppError listing the issues.
export function parseWith<T>(schema: ZodType<T>, input: unknown): T {
  const result = schema.safeParse(input);
  if (!result.success) throw zodErrorToAppError(result.error);
  return result.data;
}

const REQUEST_ID_PATTERN = /^[A-Za-z0-9._-]{1,64}$/;

// Adds an x-request-id response header and logs one line per request. Query strings are never logged.
export function requestLogger(logger: Logger): RequestHandler {
  return (req, res, next) => {
    const incoming = req.header('x-request-id');
    const requestId = incoming !== undefined && REQUEST_ID_PATTERN.test(incoming) ? incoming : randomUUID();
    const startedAt = process.hrtime.bigint();
    res.setHeader('x-request-id', requestId);
    res.on('finish', () => {
      const durationMs = Math.round(Number(process.hrtime.bigint() - startedAt) / 1e6);
      const fields = { requestId, method: req.method, path: req.path, status: res.statusCode, durationMs };
      if (req.path === '/health') logger.debug(fields, 'request');
      else logger.info(fields, 'request');
    });
    next();
  };
}
