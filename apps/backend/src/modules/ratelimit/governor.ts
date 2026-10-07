import { resolveLaneConfig, type LaneConfig, type RateWindow } from '@rs/shared';
import type { Logger } from '../../core/logger';
import type { AcquireResult, Governor, LaneDecision, LaneFailure, PausedLane, RateLimitModuleOptions, TokenGrant } from './index';
import { createDefaultInFlightCounter } from './in-flight';
import { LaneStateModel, RateCounterModel, type LaneStateDoc } from './models';
import { planPause, truncateErrorBody, type PausePlan } from './pause';
import { counterExpiry, counterId, effectiveLimit, windowBounds } from './windows';

interface WindowSpec {
  window: RateWindow;
  limit: keyof Pick<LaneConfig, 'rpd' | 'rph' | 'rpm'>;
}

// SPEC 11.2: windows are taken in this order, so a refusal on the widest window costs the least to undo.
const WINDOW_ORDER: readonly WindowSpec[] = [
  { window: 'day', limit: 'rpd' },
  { window: 'hour', limit: 'rph' },
  { window: 'minute', limit: 'rpm' },
];

const DUPLICATE_KEY = 11000;

// Two instances upserting the same counter at once can race on the unique _id. The loser's document
// exists by then, so the conditional increment that follows is still correct.
function ignoreDuplicateKey(err: unknown): void {
  if (typeof err === 'object' && err !== null && (err as { code?: unknown }).code === DUPLICATE_KEY) return;
  throw err;
}

const UNCONFIGURED_RETRY_MS = 60_000;
const UNCONFIGURED_LOG_INTERVAL_MS = 60_000;

export function createGovernor(options: RateLimitModuleOptions): Governor {
  const { getConfig } = options;
  const logger: Logger = options.logger.child({ module: 'ratelimit' });
  const clock = options.now ?? (() => new Date());
  const countInFlight = options.countInFlight ?? createDefaultInFlightCounter();
  const unconfiguredLoggedAt = new Map<string, number>();

  const laneConfig = (lane: string): LaneConfig | undefined => resolveLaneConfig(getConfig().lanes, lane);

  const rollback = async (counterIds: string[]): Promise<void> => {
    if (counterIds.length === 0) return;
    await RateCounterModel.updateMany({ _id: { $in: counterIds }, count: { $gt: 0 } }, { $inc: { count: -1 } });
  };

  const warnUnconfigured = (lane: string, now: Date): void => {
    const last = unconfiguredLoggedAt.get(lane);
    if (last !== undefined && now.getTime() - last < UNCONFIGURED_LOG_INTERVAL_MS) return;
    unconfiguredLoggedAt.set(lane, now.getTime());
    logger.error({ lane }, 'lane has no entry in generation config lanes, its jobs will not run');
  };

  const acquire = async (lane: string): Promise<AcquireResult> => {
    const now = clock();
    const config = laneConfig(lane);
    if (config === undefined) {
      warnUnconfigured(lane, now);
      return { granted: false, reason: 'paused', reopensAt: new Date(now.getTime() + UNCONFIGURED_RETRY_MS) };
    }

    const state = await LaneStateModel.findById(lane).lean<LaneStateDoc>();
    if (state?.pausedUntil != null && state.pausedUntil.getTime() > now.getTime()) {
      return { granted: false, reason: 'paused', reopensAt: state.pausedUntil };
    }

    // Read-only, so it runs before any counter is incremented and needs no rollback.
    if (config.maxConcurrent !== null && (await countInFlight(lane)) >= config.maxConcurrent) {
      return { granted: false, reason: 'concurrency', reopensAt: new Date(now.getTime() + getConfig().queue.tickMs) };
    }

    const counterIds: string[] = [];
    try {
      for (const spec of WINDOW_ORDER) {
        const limit = config[spec.limit];
        if (limit === null) continue;
        const bounds = windowBounds(spec.window, now, config.dailyResetTimeZone);
        const id = counterId(lane, spec.window, bounds.start);
        await RateCounterModel.updateOne(
          { _id: id },
          { $setOnInsert: { lane, window: spec.window, windowStart: bounds.start, count: 0, expiresAt: counterExpiry(bounds) } },
          { upsert: true },
        ).catch(ignoreDuplicateKey);
        const taken = await RateCounterModel.updateOne(
          { _id: id, count: { $lt: effectiveLimit(limit, config.safetyFactor) } },
          { $inc: { count: 1 } },
        );
        if (taken.modifiedCount === 0) {
          await rollback(counterIds);
          return { granted: false, reason: 'window', reopensAt: bounds.end };
        }
        counterIds.push(id);
      }
    } catch (err) {
      await rollback(counterIds).catch(() => undefined);
      throw err;
    }
    return { granted: true, tokens: { counterIds } };
  };

  const release = async (lane: string, tokens?: TokenGrant): Promise<void> => {
    if (tokens !== undefined) {
      await rollback(tokens.counterIds);
      return;
    }
    // No grant given: give back the tokens of the windows that are current now.
    const config = laneConfig(lane);
    if (config === undefined) return;
    const now = clock();
    const ids: string[] = [];
    for (const spec of WINDOW_ORDER) {
      if (config[spec.limit] === null) continue;
      ids.push(counterId(lane, spec.window, windowBounds(spec.window, now, config.dailyResetTimeZone).start));
    }
    await rollback(ids);
  };

  const pausedUntil = async (lane: string): Promise<Date | null> => {
    const state = await LaneStateModel.findById(lane).lean<LaneStateDoc>();
    return state?.pausedUntil != null && state.pausedUntil.getTime() > clock().getTime() ? state.pausedUntil : null;
  };

  // A 429 that arrives while the lane is already paused belongs to a request that was in flight when
  // the pause began. It must not escalate the backoff; it can only extend the pause by its RetryInfo.
  const siblingPlan = (failure: LaneFailure, now: Date): PausePlan | null =>
    failure.retryDelayMs === null || failure.retryDelayMs <= 0
      ? null
      : { reason: 'rate_limited', until: new Date(now.getTime() + failure.retryDelayMs) };

  const logPause = (lane: string, failure: LaneFailure, plan: PausePlan, consecutiveRateLimits: number | undefined): void => {
    const fields = {
      lane,
      kind: failure.kind,
      pausedUntil: plan.until.toISOString(),
      consecutiveRateLimits,
      rawBody: failure.rawBody === null ? null : truncateErrorBody(failure.rawBody),
    };
    if (plan.reason === 'provider_unavailable' || plan.reason === 'auth_error') {
      logger.error(fields, 'lane paused: provider unavailable or credentials rejected');
    } else {
      logger.warn(fields, 'lane paused');
    }
  };

  const recordFailure = async (lane: string, failure: LaneFailure): Promise<LaneDecision> => {
    const now = clock();
    const zone = laneConfig(lane)?.dailyResetTimeZone ?? 'UTC';
    if (planPause(failure, now, 0, zone) === null) return { pausedUntil: null };

    const before = await LaneStateModel.findById(lane).lean<LaneStateDoc>();
    const activeUntil = before?.pausedUntil != null && before.pausedUntil.getTime() > now.getTime() ? before.pausedUntil : null;
    const sibling = failure.kind === 'rate_limited' && activeUntil !== null;

    let consecutiveBefore = before?.consecutiveRateLimits ?? 0;
    if (failure.kind === 'rate_limited' && !sibling) {
      const bumped = await LaneStateModel.findOneAndUpdate(
        { _id: lane },
        { $inc: { consecutiveRateLimits: 1 } },
        { upsert: true, returnDocument: 'after' },
      ).lean<LaneStateDoc>();
      consecutiveBefore = (bumped?.consecutiveRateLimits ?? 1) - 1;
    }

    const plan = sibling ? siblingPlan(failure, now) : planPause(failure, now, consecutiveBefore, zone);

    const errorFields: Record<string, unknown> = { lastErrorAt: now };
    if (failure.rawBody !== null) errorFields.lastErrorBody = truncateErrorBody(failure.rawBody);
    await LaneStateModel.updateOne({ _id: lane }, { $set: errorFields }, { upsert: true });

    if (plan === null) return { pausedUntil: activeUntil };

    // Only ever extends: a shorter pause never overwrites a longer one (and its reason).
    const extended = await LaneStateModel.updateOne(
      { _id: lane, $or: [{ pausedUntil: null }, { pausedUntil: { $lt: plan.until } }] },
      { $set: { pausedUntil: plan.until, reason: plan.reason } },
    );
    if (extended.modifiedCount > 0) {
      logPause(lane, failure, plan, failure.kind === 'rate_limited' ? consecutiveBefore + 1 : undefined);
    }
    const effective = activeUntil !== null && activeUntil.getTime() > plan.until.getTime() ? activeUntil : plan.until;
    return { pausedUntil: effective };
  };

  const recordSuccess = async (lane: string): Promise<void> => {
    await LaneStateModel.updateOne(
      { _id: lane },
      { $set: { consecutiveRateLimits: 0, lastSuccessAt: clock() } },
      { upsert: true },
    );
  };

  const listPaused = async (): Promise<PausedLane[]> => {
    const states = await LaneStateModel.find({ pausedUntil: { $gt: clock() } })
      .sort({ _id: 1 })
      .lean<LaneStateDoc[]>();
    const paused: PausedLane[] = [];
    for (const state of states) {
      if (state.pausedUntil == null || state.reason === undefined) continue;
      paused.push({
        lane: state._id,
        reason: state.reason,
        pausedUntil: state.pausedUntil,
        consecutiveRateLimits: state.consecutiveRateLimits,
      });
    }
    return paused;
  };

  return { acquire, release, pausedUntil, recordFailure, recordSuccess, listPaused };
}
