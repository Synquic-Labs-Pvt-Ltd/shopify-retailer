import mongoose, { Schema } from 'mongoose';
import { LANE_PAUSE_REASONS, RATE_WINDOWS, type LanePauseReason, type RateWindow } from '@rs/shared';

// SPEC 14.10. _id is "lane|window|windowStartISO". No timestamps.
export interface RateCounterDoc {
  _id: string;
  lane: string;
  window: RateWindow;
  windowStart: Date;
  count: number;
  expiresAt: Date;
}

const rateCounterSchema = new Schema<RateCounterDoc>(
  {
    _id: { type: String, required: true },
    lane: { type: String, required: true },
    window: { type: String, enum: RATE_WINDOWS, required: true },
    windowStart: { type: Date, required: true },
    count: { type: Number, required: true, default: 0 },
    expiresAt: { type: Date, required: true },
  },
  { collection: 'rate_counters', timestamps: false, versionKey: false },
);
rateCounterSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

// SPEC 14.11. _id is the lane.
export interface LaneStateDoc {
  _id: string;
  pausedUntil?: Date | null;
  reason?: LanePauseReason;
  consecutiveRateLimits: number;
  lastErrorAt?: Date;
  lastSuccessAt?: Date;
  lastErrorBody?: string;
}

const laneStateSchema = new Schema<LaneStateDoc>(
  {
    _id: { type: String, required: true },
    pausedUntil: { type: Date },
    reason: { type: String, enum: LANE_PAUSE_REASONS },
    consecutiveRateLimits: { type: Number, required: true, default: 0 },
    lastErrorAt: { type: Date },
    lastSuccessAt: { type: Date },
    lastErrorBody: { type: String },
  },
  { collection: 'lane_states', timestamps: true, versionKey: false },
);

export const RateCounterModel = mongoose.model<RateCounterDoc>('RateCounter', rateCounterSchema);
export const LaneStateModel = mongoose.model<LaneStateDoc>('LaneState', laneStateSchema);
