import type { AiErrorKind, LanePauseReason } from '@rs/shared';

export type AcquireResult =
  | { granted: true }
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
  // Gives back a token taken by acquire when no job was claimed.
  release(lane: string): Promise<void>;
  pausedUntil(lane: string): Promise<Date | null>;
  recordFailure(lane: string, failure: LaneFailure): Promise<LaneDecision>;
  recordSuccess(lane: string): Promise<void>;
  listPaused(): Promise<PausedLane[]>;
}
