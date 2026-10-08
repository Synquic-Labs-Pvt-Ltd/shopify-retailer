import mongoose from 'mongoose';
import type { DbState } from '@rs/shared';
import type { Logger } from './logger';

// mongoose.connection.readyState: 0 disconnected, 1 connected, 2 connecting, 3 disconnecting, 99 uninitialized.
const READY_STATES: Record<number, DbState> = {
  0: 'disconnected',
  1: 'connected',
  2: 'connecting',
  3: 'disconnecting',
  99: 'uninitialized',
};

export function getDbState(): DbState {
  return READY_STATES[mongoose.connection.readyState] ?? 'uninitialized';
}

export async function connectDb(uri: string, logger: Logger, dbName?: string): Promise<void> {
  await mongoose.connect(uri, { serverSelectionTimeoutMS: 5_000, ...(dbName === undefined ? {} : { dbName }) });
  logger.info('mongo connected');
}

export async function disconnectDb(): Promise<void> {
  await mongoose.disconnect();
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// The HTTP server starts first so /health answers while Mongo is down; this keeps trying in the background.
export async function connectDbWithRetry(
  uri: string,
  logger: Logger,
  options: { retryMs?: number; signal?: AbortSignal; dbName?: string } = {},
): Promise<void> {
  const retryMs = options.retryMs ?? 5_000;
  while (options.signal?.aborted !== true) {
    try {
      await connectDb(uri, logger, options.dbName);
      return;
    } catch (err) {
      logger.error({ err }, `mongo connect failed, retrying in ${retryMs} ms`);
      await sleep(retryMs);
    }
  }
}
