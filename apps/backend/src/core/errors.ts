import type { NextFunction, Request, Response } from 'express';
import { ZodError } from 'zod';
import { ERROR_HTTP_STATUS, type ErrorCode, type ErrorEnvelope } from '@rs/shared';
import type { Logger } from './logger';

export interface AppErrorOptions {
  details?: unknown;
  status?: number;
  cause?: unknown;
}

export class AppError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  readonly details: unknown;

  constructor(code: ErrorCode, message: string, options: AppErrorOptions = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'AppError';
    this.code = code;
    this.status = options.status ?? ERROR_HTTP_STATUS[code];
    this.details = options.details;
  }

  static unauthorized(message = 'Authentication required'): AppError {
    return new AppError('unauthorized', message);
  }

  static forbidden(message = 'Forbidden'): AppError {
    return new AppError('forbidden', message);
  }

  static notFound(message = 'Not found'): AppError {
    return new AppError('not_found', message);
  }

  static validation(message: string, details?: unknown): AppError {
    return new AppError('validation_failed', message, { details });
  }

  static referencesRequired(productGids: string[]): AppError {
    return new AppError('references_required', 'Some products have no references', { details: { productGids } });
  }

  static shopLimit(message: string): AppError {
    return new AppError('shop_limit', message);
  }

  static shopReauthRequired(message = 'Shop must log in again'): AppError {
    return new AppError('shop_reauth_required', message);
  }

  static inUse(message = 'Resource is in use'): AppError {
    return new AppError('in_use', message);
  }

  static notImplemented(message = 'Not implemented'): AppError {
    return new AppError('not_implemented', message);
  }

  static internal(message = 'Internal server error', cause?: unknown): AppError {
    return new AppError('internal', message, { cause });
  }
}

export function toErrorEnvelope(error: AppError): ErrorEnvelope {
  return {
    error: {
      code: error.code,
      message: error.message,
      ...(error.details === undefined ? {} : { details: error.details }),
    },
  };
}

export function zodErrorToAppError(error: ZodError): AppError {
  const issues = error.issues.map((issue) => ({
    path: issue.path.map(String).join('.'),
    message: issue.message,
    code: issue.code,
  }));
  return AppError.validation('Request validation failed', { issues });
}

interface HttpLikeError {
  status: number;
  type?: string;
}

// body-parser (express.json / express.raw) errors carry a 4xx status and a type.
function isHttpLikeError(err: unknown): err is Error & HttpLikeError {
  if (!(err instanceof Error) || !('status' in err)) return false;
  const status: unknown = err.status;
  return typeof status === 'number' && status >= 400 && status < 500;
}

export function toAppError(err: unknown): AppError {
  if (err instanceof AppError) return err;
  if (err instanceof ZodError) return zodErrorToAppError(err);
  if (isHttpLikeError(err)) {
    const message = err.type === 'entity.too.large' ? 'Request body too large' : 'Malformed request';
    return new AppError('validation_failed', message, { status: err.status });
  }
  return AppError.internal('Internal server error', err);
}

export function notFoundHandler(req: Request, _res: Response, next: NextFunction): void {
  next(AppError.notFound(`Route not found: ${req.method} ${req.path}`));
}

export function createErrorHandler(logger: Logger) {
  return (err: unknown, req: Request, res: Response, next: NextFunction): void => {
    if (res.headersSent) {
      next(err);
      return;
    }
    const appError = toAppError(err);
    if (appError.status >= 500) {
      logger.error({ err, method: req.method, path: req.path }, 'request failed');
    }
    res.status(appError.status).json(toErrorEnvelope(appError));
  };
}
