import { Types } from 'mongoose';
import { pino, type Logger } from 'pino';
import { defaultGenerationConfig, type GenerationConfig, type JobStatus, type JobType, type LaneConfig } from '@rs/shared';
import type { Governor } from '../../src/modules/ratelimit';
import { createRateLimitModule } from '../../src/modules/ratelimit';
import { createQueueModule, type JobHandler, type JobOutcome, type QueueJob, type QueueModule } from '../../src/modules/queue';
import { JobModel, type JobDoc } from '../../src/modules/queue/models';

export const START = '2026-10-07T12:00:00.000Z';

export interface TestClock {
  now: () => Date;
  set(to: Date | string): void;
  advance(ms: number): void;
}

export function createClock(start: Date | string = START): TestClock {
  let current = new Date(start).getTime();
  return {
    now: () => new Date(current),
    set(to) {
      current = new Date(to).getTime();
    },
    advance(ms) {
      current += ms;
    },
  };
}

export const silentLogger: Logger = pino({ level: 'silent' });

export interface CapturedLog {
  level: number;
  msg: string;
  [key: string]: unknown;
}

export function captureLogger(): { logger: Logger; lines: CapturedLog[] } {
  const lines: CapturedLog[] = [];
  const logger = pino({ level: 'debug' }, { write: (chunk: string) => void lines.push(JSON.parse(chunk) as CapturedLog) });
  return { logger, lines };
}

export const ERROR_LEVEL = 50;

export function openLane(overrides: Partial<LaneConfig> = {}): LaneConfig {
  return {
    rpm: null,
    rph: null,
    rpd: null,
    maxConcurrent: null,
    safetyFactor: 1,
    dailyResetTimeZone: 'UTC',
    pollLane: null,
    ...overrides,
  };
}

export interface ConfigHolder {
  get: () => GenerationConfig;
  // Replaces the lane table or queue settings between ticks, like a live config edit.
  lanes: Record<string, LaneConfig>;
  queue: GenerationConfig['queue'];
}

export function createConfigHolder(lanes: Record<string, LaneConfig> = {}): ConfigHolder {
  const base = structuredClone(defaultGenerationConfig);
  const holder: ConfigHolder = {
    lanes: { ...base.lanes, ...lanes },
    queue: base.queue,
    get: () => ({ ...base, lanes: holder.lanes, queue: holder.queue }),
  };
  return holder;
}

export function objectId(): string {
  return new Types.ObjectId().toHexString();
}

export async function waitFor(check: () => boolean | Promise<boolean>, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('waitFor timed out');
}

export interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
}

export function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

export interface InsertJob {
  lane?: string;
  type?: JobType;
  status?: JobStatus;
  shopId?: string;
  batchId?: string;
  batchItemId?: string;
  dependsOn?: string[];
  priority?: number;
  runAt?: Date;
  createdAt?: Date;
  attempts?: number;
  maxAttempts?: number;
  lease?: { owner: string; expiresAt: Date };
  operation?: { name: string; submittedAt: Date; nextPollAt: Date; polls: number };
}

// Writes a job document directly, in any state, bypassing the store.
export async function insertJob(spec: InsertJob = {}): Promise<JobDoc> {
  const runAt = spec.runAt ?? new Date(START);
  const doc = await JobModel.create({
    shopId: new Types.ObjectId(spec.shopId ?? objectId()),
    batchId: new Types.ObjectId(spec.batchId ?? objectId()),
    batchItemId: new Types.ObjectId(spec.batchItemId ?? objectId()),
    type: spec.type ?? 'image',
    lane: spec.lane ?? 'test:lane',
    status: spec.status ?? 'queued',
    dependsOn: (spec.dependsOn ?? []).map((id) => new Types.ObjectId(id)),
    priority: spec.priority ?? 0,
    runAt,
    attempts: spec.attempts ?? 0,
    maxAttempts: spec.maxAttempts ?? 3,
    deferrals: 0,
    lease: spec.lease,
    operation: spec.operation,
    createdAt: spec.createdAt ?? runAt,
    updatedAt: spec.createdAt ?? runAt,
  });
  return doc.toObject();
}

export async function reloadJob(id: string | Types.ObjectId): Promise<JobDoc> {
  const doc = await JobModel.findById(id).lean<JobDoc>();
  if (doc === null) throw new Error(`job ${String(id)} not found`);
  return doc;
}

export interface StubGovernor extends Governor {
  acquired: string[];
  released: string[];
  deny: Set<string>;
  // Runs inside acquire, after the call is recorded and before it answers.
  onAcquire?: (lane: string) => Promise<void>;
}

// Always grants unless a lane is in `deny`; records calls. Used where the governor is not under test.
export function createStubGovernor(): StubGovernor {
  const stub: StubGovernor = {
    acquired: [],
    released: [],
    deny: new Set(),
    async acquire(lane) {
      stub.acquired.push(lane);
      if (stub.onAcquire !== undefined) await stub.onAcquire(lane);
      if (stub.deny.has(lane)) {
        return { granted: false, reason: 'window', reopensAt: new Date(new Date(START).getTime() + 60_000) };
      }
      return { granted: true, tokens: { counterIds: [] } };
    },
    async release(lane) {
      stub.released.push(lane);
    },
    async pausedUntil() {
      return null;
    },
    async recordFailure() {
      return { pausedUntil: null };
    },
    async recordSuccess() {},
    async listPaused() {
      return [];
    },
  };
  return stub;
}

export interface Rig {
  clock: TestClock;
  cfg: ConfigHolder;
  module: QueueModule;
  governor: Governor;
  terminals: QueueJob[];
  logs: CapturedLog[];
}

export interface RigOptions {
  lanes?: Record<string, LaneConfig>;
  governor?: Governor;
  instanceId?: string;
  random?: () => number;
  onTerminal?: (job: QueueJob) => void | Promise<void>;
  callTimeoutsMs?: Parameters<typeof createQueueModule>[0]['callTimeoutsMs'];
  reapIntervalMs?: number;
  shutdownGraceMs?: number;
  clock?: TestClock;
  cfg?: ConfigHolder;
}

// A queue module on the real governor (or a given one) with a controllable clock and zero jitter.
export function createRig(options: RigOptions = {}): Rig {
  const clock = options.clock ?? createClock();
  const cfg = options.cfg ?? createConfigHolder(options.lanes);
  const { logger, lines } = captureLogger();
  const governor =
    options.governor ?? createRateLimitModule({ getConfig: cfg.get, logger, now: clock.now }).governor;
  const terminals: QueueJob[] = [];
  const module = createQueueModule({
    getConfig: cfg.get,
    governor,
    logger,
    now: clock.now,
    instanceId: options.instanceId ?? 'runner-a',
    random: options.random ?? (() => 0),
    onTerminal: options.onTerminal ?? ((job) => void terminals.push(job)),
    ...(options.callTimeoutsMs === undefined ? {} : { callTimeoutsMs: options.callTimeoutsMs }),
    ...(options.reapIntervalMs === undefined ? {} : { reapIntervalMs: options.reapIntervalMs }),
    ...(options.shutdownGraceMs === undefined ? {} : { shutdownGraceMs: options.shutdownGraceMs }),
  });
  return { clock, cfg, module, governor, terminals, logs: lines };
}

export type RunFn = (job: QueueJob, signal: AbortSignal) => Promise<JobOutcome>;

export function handlerFor(type: JobType, run: RunFn, poll?: RunFn): JobHandler {
  return poll === undefined ? { type, run } : { type, run, poll };
}

// Runs one tick and waits for every handler started by it.
export async function tickAndSettle(rig: Rig): Promise<void> {
  await rig.module.runner.tickOnce();
  await rig.module.runner.idle();
}
