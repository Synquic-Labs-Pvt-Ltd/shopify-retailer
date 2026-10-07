import type { AiErrorKind, GenerationConfig, LanePauseReason } from '@rs/shared';
import type { Logger } from '../../core/logger';

// Identifies the counter documents one acquire incremented, so release gives back exactly those
// tokens even when a window rolled over in between.
export interface TokenGrant {
  counterIds: string[];
}

export type AcquireResult =
  | { granted: true; tokens?: TokenGrant }
  | { granted: false; reason: 'paused' | 'window' | 'concurrency'; reopensAt: Date };

// A classified provider failure, reduced to what lane pausing needs (SPEC 11.2 table).
export interface LaneFailure {
  kind: AiErrorKind;
  // From RetryInfo when the provider sent one.
  retryDelayMs: number | null;
  // Raw provider body, stored truncated to 4 KB in lane_states.
  rawBody: string | null;
}

export interface LaneDecision {
  pausedUntil: Date | null;
}

export interface PausedLane {
  lane: string;
  reason: LanePauseReason;
  pausedUntil: Date;
  consecutiveRateLimits: number;
}

export interface Governor {
  // Takes a token in every defined window (day, hour, minute) and checks the concurrency gate.
  acquire(lane: string): Promise<AcquireResult>;
  // Gives back a token taken by acquire when no job was claimed. Pass the grant from acquire.
  release(lane: string, tokens?: TokenGrant): Promise<void>;
  pausedUntil(lane: string): Promise<Date | null>;
  recordFailure(lane: string, failure: LaneFailure): Promise<LaneDecision>;
  recordSuccess(lane: string): Promise<void>;
  listPaused(): Promise<PausedLane[]>;
}

export interface RateLimitService {
  readonly governor: Governor;
  // Creates the rate_counters (TTL) and lane_states indexes. Mongoose also does this on connect.
  ensureIndexes(): Promise<void>;
}

export interface RateLimitModuleOptions {
  // Read at every use, so edits to the generation config apply without a restart.
  getConfig: () => GenerationConfig;
  logger: Logger;
  now?: () => Date;
  // Jobs of the lane with status running or awaiting_operation (the concurrency gate).
  // Defaults to counting them in the jobs collection.
  countInFlight?: (lane: string) => Promise<number>;
}

export { createRateLimitModule } from './module';
