import { Types } from 'mongoose';
import type { ItemStatus } from '@rs/shared';
import type { JobStore, QueueJob } from '../queue';
import { BatchItemModel, BatchModel, type BatchDoc, type BatchItemDoc } from './models';
import { deriveBatch, deriveItem, type ItemDerivation, type JobFact } from './status';

export type BatchRow = Pick<BatchDoc, '_id' | 'status' | 'counts' | 'finishedAt'>;
export type ItemRow = Pick<BatchItemDoc, '_id' | 'status' | 'planSource' | 'counts' | 'outputMediaIds' | 'finishedAt'>;

export const ITEM_PROJECTION = { status: 1, planSource: 1, counts: 1, outputMediaIds: 1, finishedAt: 1 } as const;

const sameIds = (a: readonly Types.ObjectId[], b: readonly string[]): boolean =>
  a.length === b.length && a.every((id, index) => id.toHexString() === b[index]);

function toFact(job: QueueJob): JobFact {
  return { type: job.type, status: job.status, outputIndex: job.outputIndex, mediaId: job.output?.mediaAssetId ?? null };
}

function itemChanged(item: ItemRow, derived: ItemDerivation): boolean {
  const { counts } = item;
  return (
    counts.succeeded !== derived.counts.succeeded ||
    counts.failed !== derived.counts.failed ||
    counts.cancelled !== derived.counts.cancelled ||
    (derived.status !== null && derived.status !== item.status) ||
    !sameIds(item.outputMediaIds, derived.outputMediaIds) ||
    derived.terminal !== (item.finishedAt != null)
  );
}

export interface ItemUpdate {
  id: Types.ObjectId;
  set: Record<string, unknown>;
  terminal: boolean;
  finishedAt: Date | null | undefined;
}

export interface RecountPlan {
  items: ItemUpdate[];
  batch: { set: Record<string, unknown>; terminal: boolean; finishedAt: Date | null | undefined };
  changed: boolean;
}

// What the stored counters and statuses should be, given the jobs. Pure: nothing is written here.
export function planRecount(batch: BatchRow, items: readonly ItemRow[], jobs: readonly QueueJob[]): RecountPlan {
  const factsByItem = new Map<string, JobFact[]>();
  for (const job of jobs) {
    const facts = factsByItem.get(job.batchItemId) ?? [];
    facts.push(toFact(job));
    factsByItem.set(job.batchItemId, facts);
  }

  const updates: ItemUpdate[] = [];
  const itemStatuses: ItemStatus[] = [];
  for (const item of items) {
    const state = { status: item.status, planned: item.planSource != null, expectedJobs: item.counts.jobsTotal };
    const derived = deriveItem(factsByItem.get(item._id.toHexString()) ?? [], state);
    itemStatuses.push(derived.status ?? item.status);
    if (!itemChanged(item, derived)) continue;
    updates.push({
      id: item._id,
      terminal: derived.terminal,
      finishedAt: item.finishedAt,
      set: {
        'counts.succeeded': derived.counts.succeeded,
        'counts.failed': derived.counts.failed,
        'counts.cancelled': derived.counts.cancelled,
        outputMediaIds: derived.outputMediaIds.map((id) => new Types.ObjectId(id)),
        ...(derived.status === null ? {} : { status: derived.status }),
      },
    });
  }

  const derived = deriveBatch(jobs.map(toFact), itemStatuses, { status: batch.status, expectedJobs: batch.counts.jobsTotal });
  const set: Record<string, unknown> = {
    'counts.jobsSucceeded': derived.counts.jobsSucceeded,
    'counts.jobsFailed': derived.counts.jobsFailed,
    'counts.jobsCancelled': derived.counts.jobsCancelled,
    'counts.imagesReady': derived.counts.imagesReady,
    'counts.videosReady': derived.counts.videosReady,
    ...(derived.status === null ? {} : { status: derived.status }),
  };
  const { counts } = batch;
  const batchChanged =
    counts.jobsSucceeded !== derived.counts.jobsSucceeded ||
    counts.jobsFailed !== derived.counts.jobsFailed ||
    counts.jobsCancelled !== derived.counts.jobsCancelled ||
    counts.imagesReady !== derived.counts.imagesReady ||
    counts.videosReady !== derived.counts.videosReady ||
    (derived.status !== null && derived.status !== batch.status) ||
    derived.terminal !== (batch.finishedAt != null);

  return {
    items: updates,
    batch: { set, terminal: derived.terminal, finishedAt: batch.finishedAt },
    changed: batchChanged || updates.length > 0,
  };
}

// Counters and statuses are recomputed from the jobs, never incremented, so a job reported twice counts
// once and a lost report is repaired by the next one (SPEC 10.5). Concurrent recounts are ordered by a
// ticket: every write is stamped with its ticket and only lands when no newer recount has written, so an
// older, staler recount can never overwrite a newer one. Each recount reads after taking its ticket, and
// a job's report takes its ticket after the job's terminal write, so the newest ticket always sees it.
export function createAggregator(deps: { store: JobStore; now: () => Date }) {
  return async function recount(shopId: string, batchId: string): Promise<void> {
    const claimed = await BatchModel.findOneAndUpdate(
      { _id: new Types.ObjectId(batchId), shopId: new Types.ObjectId(shopId) },
      { $inc: { statsSeq: 1 } },
      { returnDocument: 'after' },
    ).lean<BatchDoc>();
    if (claimed === null) return;
    const ticket = claimed.statsSeq;

    const [jobs, items] = await Promise.all([
      deps.store.listByBatch(shopId, batchId),
      BatchItemModel.find({ batchId: claimed._id }).sort({ _id: 1 }).select(ITEM_PROJECTION).lean<ItemRow[]>(),
    ]);
    const plan = planRecount(claimed, items, jobs);
    const now = deps.now();

    for (const item of plan.items) {
      const set = { ...item.set, statsApplied: ticket };
      await BatchItemModel.updateOne(
        { _id: item.id, statsApplied: { $lt: ticket } },
        item.terminal ? { $set: { ...set, finishedAt: item.finishedAt ?? now } } : { $set: set, $unset: { finishedAt: 1 } },
      );
    }
    const set = { ...plan.batch.set, statsApplied: ticket };
    await BatchModel.updateOne(
      { _id: claimed._id, statsApplied: { $lt: ticket } },
      plan.batch.terminal ? { $set: { ...set, finishedAt: plan.batch.finishedAt ?? now } } : { $set: set, $unset: { finishedAt: 1 } },
    );
  };
}

export type Recount = ReturnType<typeof createAggregator>;
