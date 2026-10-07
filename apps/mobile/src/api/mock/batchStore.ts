import type {
  BatchDelay,
  BatchDetail,
  BatchItemView,
  BatchJobView,
  BatchSummary,
  CreateBatchInput,
  ItemStatus,
  JobStatus,
  JobType,
  MediaObject,
  ReferenceMode,
} from '@rs/shared';
import { ApiError } from '../types';
import { PRODUCTS } from './fixtures';
import { IMAGES_PER_PRODUCT, SAMPLE_VIDEO_URL, VIDEOS_PER_PRODUCT, objectId, picture, productGid } from './util';

// Batches in mock mode are a pure function of the clock. A batch created at t0 behaves like this:
//   t0 + 1.0 s   plan of product 1 starts; product k starts 1.5 s later than product k-1
//   +1.5 s       each plan ends; its two image jobs and the video job start
//   +2.0 / +3.5 s  the two images finish and appear one by one
//   +7.5 s       the video finishes. The video of one product (the second, or the only one) FAILS
//   t0 + 5.0 to 8.5 s  the batch carries a delay object (provider busy)
// so successive polls see queued -> running -> completed_with_errors. Retry failed restarts that video, which
// then succeeds after 5.8 s. Cancel freezes the clock: whatever was done stays, the rest is cancelled.

const FIRST_START_MS = 1_000;
const ITEM_STAGGER_MS = 1_500;
const PLAN_MS = 1_500;
const IMAGE_MS: readonly number[] = [2_000, 3_500];
const VIDEO_MS = 7_500;
const RETRY_QUEUED_MS = 800;
const RETRY_RUN_MS = 5_000;
const DELAY_FROM_MS = 5_000;
const DELAY_UNTIL_MS = 8_500;
const MAX_ACTIVE_BATCHES = 3;
const SHOT_TITLES = ['Hero shot', 'Detail close-up', 'Slow push-in'] as const;
const MODES: readonly ReferenceMode[] = ['common_only', 'own_plus_common', 'own_only'];

interface SimItem {
  productGid: string;
  referenceMode: ReferenceMode;
  failVideo: boolean;
}

interface SimBatch {
  index: number;
  id: string;
  idempotencyKey: string;
  createdAtMs: number;
  cancelledAtMs: number | null;
  retriedAtMs: number | null;
  items: SimItem[];
}

interface SimJob extends BatchJobView {
  finishedAtMs: number | null;
}

interface SimItemState {
  plan: SimJob;
  work: SimJob[];
}

const isoOf = (ms: number): string => new Date(ms).toISOString();
const isTerminalJob = (status: JobStatus): boolean => status === 'succeeded' || status === 'failed' || status === 'cancelled';

function simulateItem(batch: SimBatch, itemIndex: number, clockMs: number): SimItemState {
  const item = batch.items[itemIndex];
  const elapsed = clockMs - batch.createdAtMs;
  const planStart = FIRST_START_MS + itemIndex * ITEM_STAGGER_MS;
  const planEnd = planStart + PLAN_MS;

  const plan: SimJob = {
    type: 'plan',
    outputIndex: null,
    errorCode: null,
    status: elapsed < planStart ? 'queued' : elapsed < planEnd ? 'running' : 'succeeded',
    finishedAtMs: elapsed >= planEnd ? batch.createdAtMs + planEnd : null,
  };

  const shots: { type: JobType; outputIndex: number; durationMs: number; active: JobStatus }[] = [
    { type: 'image', outputIndex: 0, durationMs: IMAGE_MS[0] ?? 2_000, active: 'running' },
    { type: 'image', outputIndex: 1, durationMs: IMAGE_MS[1] ?? 3_500, active: 'running' },
    { type: 'video', outputIndex: 0, durationMs: VIDEO_MS, active: 'awaiting_operation' },
  ];

  const work = shots.map((shot): SimJob => {
    const base = { type: shot.type, outputIndex: shot.outputIndex, errorCode: null, finishedAtMs: null };
    const endMs = planEnd + shot.durationMs;
    if (elapsed < planEnd) return { ...base, status: 'blocked' };
    if (elapsed < endMs) return { ...base, status: shot.active };
    const failed = shot.type === 'video' && item?.failVideo === true;
    if (!failed) return { ...base, status: 'succeeded', finishedAtMs: batch.createdAtMs + endMs };
    if (batch.retriedAtMs === null) {
      return { ...base, status: 'failed', errorCode: 'safety_blocked', finishedAtMs: batch.createdAtMs + endMs };
    }
    const sinceRetry = clockMs - batch.retriedAtMs;
    if (sinceRetry < RETRY_QUEUED_MS) return { ...base, status: 'queued' };
    if (sinceRetry < RETRY_QUEUED_MS + RETRY_RUN_MS) return { ...base, status: 'awaiting_operation' };
    return { ...base, status: 'succeeded', finishedAtMs: batch.retriedAtMs + RETRY_QUEUED_MS + RETRY_RUN_MS };
  });

  if (batch.cancelledAtMs === null) return { plan, work };
  const cancel = (job: SimJob): SimJob =>
    isTerminalJob(job.status) ? job : { ...job, status: 'cancelled', errorCode: 'cancelled' };
  return { plan: cancel(plan), work: work.map(cancel) };
}

function itemStatusOf({ plan, work }: SimItemState): ItemStatus {
  if ([plan, ...work].some((job) => job.status === 'cancelled')) return 'cancelled';
  if (plan.status === 'queued') return 'pending';
  if (plan.status === 'running') return 'planning';
  if (work.some((job) => !isTerminalJob(job.status))) return 'generating';
  const succeeded = work.filter((job) => job.status === 'succeeded').length;
  if (succeeded === work.length) return 'completed';
  return succeeded > 0 ? 'partial' : 'failed';
}

function outputOf(batch: SimBatch, itemIndex: number, job: SimJob): MediaObject {
  const gid = batch.items[itemIndex]?.productGid ?? '';
  const handle = PRODUCTS.find((product) => product.id === gid)?.handle ?? 'product';
  const isVideo = job.type === 'video';
  const key = isVideo ? IMAGES_PER_PRODUCT + (job.outputIndex ?? 0) : (job.outputIndex ?? 0);
  return {
    id: objectId(0x700000 + batch.index * 1000 + itemIndex * 10 + key),
    role: 'output',
    mediaType: isVideo ? 'video' : 'image',
    status: 'ready',
    url: isVideo ? SAMPLE_VIDEO_URL : picture(`${handle}-out-${key}`, 1536, 2048),
    previewUrl: picture(`${handle}-out-${key}`, 600, 800),
    width: isVideo ? 720 : 1536,
    height: isVideo ? 1280 : 2048,
    durationSec: isVideo ? 8 : null,
    filename: `rs-${handle}-${batch.id.slice(-6)}-${isVideo ? 'vid' : 'img'}${(job.outputIndex ?? 0) + 1}.${isVideo ? 'mp4' : 'jpg'}`,
    scope: null,
    productGid: gid,
    shotTitle: SHOT_TITLES[key] ?? null,
    createdAt: isoOf(job.finishedAtMs ?? batch.createdAtMs),
  };
}

function itemView(batch: SimBatch, itemIndex: number, state: SimItemState): BatchItemView {
  const item = batch.items[itemIndex];
  const product = PRODUCTS.find((candidate) => candidate.id === item?.productGid);
  const toView = ({ type, outputIndex, status, errorCode }: SimJob): BatchJobView => ({ type, outputIndex, status, errorCode });
  return {
    id: objectId(0x600000 + batch.index * 1000 + itemIndex),
    productGid: item?.productGid ?? '',
    title: product?.title ?? 'Unknown product',
    imageUrl: product?.featuredImageUrl ?? null,
    status: itemStatusOf(state),
    referenceMode: item?.referenceMode ?? 'common_only',
    outputs: state.work.filter((job) => job.status === 'succeeded').map((job) => outputOf(batch, itemIndex, job)),
    jobs: [toView(state.plan), ...state.work.map(toView)],
  };
}

function deriveBatch(batch: SimBatch, nowMs: number): BatchDetail {
  const clockMs = batch.cancelledAtMs ?? nowMs;
  const states = batch.items.map((_, index) => simulateItem(batch, index, clockMs));
  const items = states.map((state, index) => itemView(batch, index, state));
  const jobs = states.flatMap((state) => [state.plan, ...state.work]);
  const count = (status: JobStatus): number => jobs.filter((job) => job.status === status).length;

  const itemStatuses = items.map((item) => item.status);
  const outputs = items.flatMap((item) => item.outputs);
  const finished = itemStatuses.every((status) => status !== 'pending' && status !== 'planning' && status !== 'generating');

  let status: BatchDetail['status'];
  if (batch.cancelledAtMs !== null) status = 'cancelled';
  else if (itemStatuses.every((itemStatus) => itemStatus === 'pending')) status = 'queued';
  else if (!finished) status = 'running';
  else if (count('failed') === 0) status = 'completed';
  else status = outputs.length > 0 ? 'completed_with_errors' : 'failed';

  const terminal = status !== 'queued' && status !== 'running';
  const lastFinishMs = Math.max(batch.createdAtMs, ...jobs.map((job) => job.finishedAtMs ?? 0));
  const elapsed = clockMs - batch.createdAtMs;
  const delay: BatchDelay | null =
    !terminal && elapsed >= DELAY_FROM_MS && elapsed < DELAY_UNTIL_MS
      ? { reason: 'rate_limited', resumesAt: isoOf(batch.createdAtMs + DELAY_UNTIL_MS) }
      : null;

  return {
    id: batch.id,
    status,
    counts: {
      products: items.length,
      jobsTotal: jobs.length,
      jobsSucceeded: count('succeeded'),
      jobsFailed: count('failed'),
      jobsCancelled: count('cancelled'),
      imagesReady: outputs.filter((output) => output.mediaType === 'image').length,
      videosReady: outputs.filter((output) => output.mediaType === 'video').length,
    },
    createdAt: isoOf(batch.createdAtMs),
    finishedAt: terminal ? isoOf(batch.cancelledAtMs ?? lastFinishMs) : null,
    coverImageUrl: items[0]?.imageUrl ?? null,
    configSnapshot: { outputs: { imagesPerProduct: IMAGES_PER_PRODUCT, videosPerProduct: VIDEOS_PER_PRODUCT } },
    items,
    delay,
  };
}

function toSummary(detail: BatchDetail): BatchSummary {
  return {
    id: detail.id,
    status: detail.status,
    counts: detail.counts,
    createdAt: detail.createdAt,
    finishedAt: detail.finishedAt,
    coverImageUrl: detail.coverImageUrl,
    configSnapshot: detail.configSnapshot,
  };
}

export interface MockBatchStore {
  create(body: CreateBatchInput): BatchSummary;
  list(): BatchSummary[];
  get(id: string): BatchDetail;
  cancel(id: string): BatchSummary;
  retryFailed(id: string): BatchSummary;
}

interface SeedSpec {
  minutesAgo: number;
  products: number[];
  // Index of the item whose video failed, if any.
  failedItem?: number;
  // Cancelled this many seconds after it was created.
  cancelledAfterSec?: number;
}

// Older batches for the Queue list: completed, completed with errors (retry failed works on it), cancelled.
const SEEDS: SeedSpec[] = [
  { minutesAgo: 25, products: [0, 1, 2] },
  { minutesAgo: 190, products: [3, 4, 5, 6], failedItem: 2 },
  { minutesAgo: 26 * 60, products: [7, 8], cancelledAfterSec: 6.5 },
];

export function createMockBatchStore(): MockBatchStore {
  const batches = new Map<string, SimBatch>();

  const add = (items: SimItem[], createdAtMs: number, idempotencyKey: string): SimBatch => {
    const index = batches.size;
    const batch: SimBatch = {
      index,
      id: objectId(0x400000 + index),
      idempotencyKey,
      createdAtMs,
      cancelledAtMs: null,
      retriedAtMs: null,
      items,
    };
    batches.set(batch.id, batch);
    return batch;
  };

  SEEDS.forEach((spec, seedIndex) => {
    const createdAtMs = Date.now() - spec.minutesAgo * 60_000;
    const batch = add(
      spec.products.map((product, i) => ({
        productGid: productGid(product),
        referenceMode: MODES[i % MODES.length] ?? 'common_only',
        failVideo: spec.failedItem === i,
      })),
      createdAtMs,
      `seed-${seedIndex}`,
    );
    if (spec.cancelledAfterSec !== undefined) batch.cancelledAtMs = createdAtMs + spec.cancelledAfterSec * 1000;
  });

  const getBatch = (id: string): SimBatch => {
    const batch = batches.get(id);
    if (batch === undefined) throw new ApiError(404, 'not_found', 'Batch not found');
    return batch;
  };

  const detailOf = (batch: SimBatch): BatchDetail => deriveBatch(batch, Date.now());

  return {
    create: (body) => {
      for (const existing of batches.values()) {
        if (existing.idempotencyKey === body.idempotencyKey) return toSummary(detailOf(existing));
      }
      const common = body.commonReferenceMediaIds ?? [];
      const unresolved = body.products
        .filter((product) => (product.referenceMediaIds ?? []).length === 0 && common.length === 0)
        .map((product) => product.productGid);
      if (unresolved.length > 0) {
        throw new ApiError(422, 'references_required', 'Some products have no references', { productGids: unresolved });
      }
      if (body.products.some((product) => !PRODUCTS.some((candidate) => candidate.id === product.productGid))) {
        throw new ApiError(400, 'validation_failed', 'One of the products does not exist');
      }
      const active = [...batches.values()].filter((batch) => {
        const { status } = detailOf(batch);
        return status === 'queued' || status === 'running';
      }).length;
      if (active >= MAX_ACTIVE_BATCHES) {
        throw new ApiError(
          429,
          'shop_limit',
          `You already have ${MAX_ACTIVE_BATCHES} generations running. Wait for one to finish.`,
        );
      }
      const failedItem = body.products.length > 1 ? 1 : 0;
      const batch = add(
        body.products.map((product, i): SimItem => {
          const own = (product.referenceMediaIds ?? []).length > 0;
          const mode: ReferenceMode = own ? (common.length > 0 ? 'own_plus_common' : 'own_only') : 'common_only';
          return { productGid: product.productGid, referenceMode: mode, failVideo: i === failedItem };
        }),
        Date.now(),
        body.idempotencyKey,
      );
      return toSummary(detailOf(batch));
    },

    list: () =>
      [...batches.values()]
        .sort((a, b) => b.createdAtMs - a.createdAtMs)
        .map((batch) => toSummary(detailOf(batch))),

    get: (id) => detailOf(getBatch(id)),

    cancel: (id) => {
      const batch = getBatch(id);
      const { status } = detailOf(batch);
      if (batch.cancelledAtMs === null && (status === 'queued' || status === 'running')) batch.cancelledAtMs = Date.now();
      return toSummary(detailOf(batch));
    },

    retryFailed: (id) => {
      const batch = getBatch(id);
      const detail = detailOf(batch);
      const terminalWithErrors = detail.status === 'completed_with_errors' || detail.status === 'failed';
      const retryable = terminalWithErrors && batch.retriedAtMs === null;
      if (retryable) batch.retriedAtMs = Date.now();
      return toSummary(detailOf(batch));
    },
  };
}
