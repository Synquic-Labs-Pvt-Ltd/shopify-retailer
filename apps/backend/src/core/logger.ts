import { pino, type Logger } from 'pino';

export type { Logger };

export const LOG_LEVELS = ['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

export function createLogger(level: LogLevel = 'info'): Logger {
  return pino({
    level,
    redact: {
      paths: ['req.headers.authorization', '*.accessToken', '*.refreshToken', '*.token'],
      censor: '[redacted]',
    },
  });
}
