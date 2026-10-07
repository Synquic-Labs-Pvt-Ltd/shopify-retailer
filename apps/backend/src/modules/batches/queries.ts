import { Types } from 'mongoose';
import {
  resolveLaneConfig,
  type BatchDelay,
  type BatchDetail,
  type BatchItemView,
  type BatchJobView,
  type BatchListQuery,
  type BatchListResponse,
  type MediaObject,
} from '@rs/shared';
import { AppError } from '../../core/errors';
import type { QueueJob } from '../queue';
import { planRecount, type Recount } from './aggregation';
import type { BatchesModuleDeps } from './index';
import { toSummary } from './mapper';
import { BatchItemModel, BatchModel, type BatchDoc, type BatchItemDoc } from './models';

type QueryDeps = Pick<BatchesModuleDeps, 'getConfig' | 'queue' | 'governor' | 'media'> & { recount: Recount };

const TERMINAL_JOB_STATUSES = new Set(['succeeded', 'failed', 'cancelled']);

export function encodeCursor(doc: Pick<BatchDoc, '_id' | 'createdAt'>): string {
  return Buffer.from(`${doc.createdAt.getTime()}:${doc._id.toHexString()}`).toString('base64url');
}

function decodeCursor(cursor: string): { createdAt: Date; id: Types.ObjectId } {
  const [ms, id] = Buffer.from(cursor, 'base64url').toString('utf8').split(':');
  const time = Number(ms);
  if (!Number.isFinite(time) || id === undefined || !/^[a-f0-9]{24}$/.test(id)) throw AppError.validation('Invalid cursor');
  return { createdAt: new Date(time), id: new Types.ObjectId(id) };
}

export async function findBatch(shopId: string, batchId: string): Promise<BatchDoc> {
  if (!/^[a-f0-9]{24}$/.test(batchId)) throw AppError.notFound('Batch not found');
  const batch = await BatchModel.findOne({ _id: new Types.ObjectId(batchId), shopId: new Types.ObjectId(shopId) }).lean<BatchDoc>();
  if (batch === null) throw AppError.notFound('Batch not found');
  return batch;
}

function jobView(job: QueueJob): BatchJobView {
  const failed = job.status === 'failed' || job.status === 'cancelled';
  return { type: job.type, outputIndex: job.outputIndex, status: job.status, errorCode: failed ? (job.error?.code ?? null) : null };
}

// Plan first, then images, then videos, each by outputIndex.
function byDisplayOrder(a: QueueJob, b: QueueJob): number {
  const rank = { plan: 0, image: 1, video: 2 } as const;
  return rank[a.type] - rank[b.type] || (a.outputIndex ?? 0) - (b.outputIndex ?? 0);
}

export function createQueries(deps: QueryDeps) {
  const { queue, governor, media, recount } = deps;

  async function listBatches(shopId: string, query: BatchListQuery): Promise<BatchListResponse> {
    const filter: Record<string, unknown> = { shopId: new Types.ObjectId(shopId) };
    if (query.cursor !== undefined) {
      const after = decodeCursor(query.cursor);
      filter.$or = [{ createdAt: { $lt: after.createdAt } }, { createdAt: after.createdAt, _id: { $lt: after.id } }];
    }
    const rows = await BatchModel.find(filter)
      .sort({ createdAt: -1, _id: -1 })
      .limit(query.limit + 1)
      .lean<BatchDoc[]>();
    const page = rows.slice(0, query.limit);
    const last = page[page.length - 1];
    const hasNextPage = rows.length > query.limit;
    return {
      items: page.map(toSummary),
      pageInfo: { endCursor: hasNextPage && last !== undefined ? encodeCursor(last) : null, hasNextPage },
    };
  }

  // The earliest reopen among paused lanes that hold a non-terminal job of the batch (SPEC 11.2). A video
  // job that is only being polled waits on its poll lane, not on its submit lane.
  async function pausedDelay(jobs: readonly QueueJob[]): Promise<BatchDelay | null> {
    const waiting = jobs.filter((job) => !TERMINAL_JOB_STATUSES.has(job.status));
    if (waiting.length === 0) return null;
    const lanes = deps.getConfig().lanes;
    const used = new Set<string>();
    for (const job of waiting) {
      if (job.status === 'awaiting_operation') {
        const pollLane = resolveLaneConfig(lanes, job.lane)?.pollLane;
        if (pollLane != null) used.add(pollLane);
      } else {
        used.add(job.lane);
      }
    }
    const paused = (await governor.listPaused()).filter((lane) => used.has(lane.lane));
    const earliest = paused.sort((a, b) => a.pausedUntil.getTime() - b.pausedUntil.getTime())[0];
    return earliest === undefined ? null : { reason: earliest.reason, resumesAt: earliest.pausedUntil.toISOString() };
  }

  async function load(shopId: string, batchId: string) {
    const batch = await findBatch(shopId, batchId);
    const [items, jobs] = await Promise.all([
      BatchItemModel.find({ batchId: batch._id }).sort({ _id: 1 }).lean<BatchItemDoc[]>(),
      queue.store.listByBatch(shopId, batchId),
    ]);
    return { batch, items, jobs };
  }

  async function getBatch(shopId: string, batchId: string): Promise<BatchDetail> {
    let loaded = await load(shopId, batchId);
    // Counters that disagree with the jobs mean a completion report was lost: repair them before answering.
    if (planRecount(loaded.batch, loaded.items, loaded.jobs).changed) {
      await recount(shopId, batchId);
      loaded = await load(shopId, batchId);
    }
    const { batch, items, jobs } = loaded;

    const outputIds = [...new Set(items.flatMap((item) => item.outputMediaIds.map((id) => id.toHexString())))];
    const objects = outputIds.length === 0 ? [] : await media.getObjects(shopId, outputIds);
    const objectById = new Map<string, MediaObject>(objects.map((object) => [object.id, object]));

    const jobsByItem = new Map<string, QueueJob[]>();
    for (const job of jobs) jobsByItem.set(job.batchItemId, [...(jobsByItem.get(job.batchItemId) ?? []), job]);

    const views: BatchItemView[] = items.map((item) => ({
      id: item._id.toHexString(),
      productGid: item.productGid,
      title: item.productSnapshot.title,
      imageUrl: item.productSnapshot.featuredImageUrl ?? item.productSnapshot.imageUrls[0] ?? null,
      status: item.status,
      referenceMode: item.referenceMode,
      outputs: item.outputMediaIds.flatMap((id) => {
        const object = objectById.get(id.toHexString());
        return object === undefined ? [] : [object];
      }),
      jobs: [...(jobsByItem.get(item._id.toHexString()) ?? [])].sort(byDisplayOrder).map(jobView),
    }));

    return { ...toSummary(batch), items: views, delay: await pausedDelay(jobs) };
  }

  return { listBatches, getBatch };
}
