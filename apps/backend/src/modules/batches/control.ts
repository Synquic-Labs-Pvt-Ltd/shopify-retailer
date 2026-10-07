import { Types } from 'mongoose';
import { isTerminalBatchStatus, type BatchSummary } from '@rs/shared';
import { AppError } from '../../core/errors';
import type { BatchActor, BatchesModuleDeps } from './index';
import type { Recount } from './aggregation';
import { toSummary } from './mapper';
import { BatchModel, type BatchDoc } from './models';
import { findBatch } from './queries';

type ControlDeps = Pick<BatchesModuleDeps, 'queue' | 'shops' | 'logger'> & { now: () => Date; recount: Recount };

const ACTIVE_STATUSES = ['queued', 'running'] as const;

// Cancel, retry-failed and shop-wide cancellation. Queue-side cancelling fires no onTerminal, so each of
// these recounts the batch from its jobs afterwards.
export function createControl(deps: ControlDeps) {
  const { queue, shops, now, recount } = deps;

  const reload = async (shopId: string, batchId: string): Promise<BatchSummary> => toSummary(await findBatch(shopId, batchId));

  async function cancel(actor: BatchActor, batchId: string): Promise<BatchSummary> {
    const batch = await findBatch(actor.shopId, batchId);
    if (isTerminalBatchStatus(batch.status)) return toSummary(batch);
    await BatchModel.updateOne({ _id: batch._id, cancelRequestedAt: { $exists: false } }, { $set: { cancelRequestedAt: now() } });
    await queue.store.cancelByBatch(actor.shopId, batchId);
    await recount(actor.shopId, batchId);
    return reload(actor.shopId, batchId);
  }

  async function retryFailed(actor: BatchActor, batchId: string): Promise<BatchSummary> {
    await shops.requireActive(actor.shopId);
    const batch = await findBatch(actor.shopId, batchId);
    if (!isTerminalBatchStatus(batch.status)) throw AppError.validation('Only a finished batch can be retried');
    if (batch.cancelRequestedAt != null) throw AppError.validation('A cancelled batch cannot be retried');
    if ((await queue.store.requeueFailed(actor.shopId, batchId)) > 0) await recount(actor.shopId, batchId);
    return reload(actor.shopId, batchId);
  }

  // Uninstall (SPEC 8.4): every non-terminal job of the shop is cancelled, so every active batch ends.
  async function cancelAllForShop(shopId: string): Promise<number> {
    const shop = new Types.ObjectId(shopId);
    const active = await BatchModel.find({ shopId: shop, status: { $in: ACTIVE_STATUSES } }).select({ _id: 1 }).lean<Pick<BatchDoc, '_id'>[]>();
    await BatchModel.updateMany(
      { _id: { $in: active.map((batch) => batch._id) }, cancelRequestedAt: { $exists: false } },
      { $set: { cancelRequestedAt: now() } },
    );
    await queue.store.cancelByShop(shopId);
    for (const batch of active) await recount(shopId, batch._id.toHexString());
    return active.length;
  }

  return { cancel, retryFailed, cancelAllForShop };
}
