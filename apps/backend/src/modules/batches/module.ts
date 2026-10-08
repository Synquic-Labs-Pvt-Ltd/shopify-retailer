import { Types } from 'mongoose';
import { createAggregator } from './aggregation';
import { createAttachMedia } from './attach';
import { createControl } from './control';
import { createBatchCreator } from './create';
import type { BatchesModule, BatchesModuleDeps, BatchesService } from './index';
import { createItemService } from './items';
import { BatchItemModel, BatchModel, type BatchDoc } from './models';
import { createQueries } from './queries';
import { createBatchesRouter } from './routes';

const ACTIVE_STATUSES = ['queued', 'running'] as const;

// The queue swallows a failing listener, so a transient database error is retried here instead of leaving
// the counters stale until the next job of the batch finishes (getBatch also repairs them on read).
const RETRY_DELAYS_MS = [200, 1000, 3000];

async function withRetry(work: () => Promise<void>): Promise<void> {
  for (const delay of RETRY_DELAYS_MS) {
    try {
      return await work();
    } catch {
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
  return work();
}

// Wire after the queue module, then:
//   container.onJobTerminal(batches.service.reportJobFinished)
//   generation = createGenerationModule({ batches: batches.service, ... })
//   app.use('/api/v1', batches.router)
export function createBatchesModule(deps: BatchesModuleDeps): BatchesModule {
  const now = deps.now ?? (() => new Date());
  const recount = createAggregator({ store: deps.queue.store, now });
  const items = createItemService({ media: deps.media, now });
  const queries = createQueries({ ...deps, recount });
  const control = createControl({ queue: deps.queue, shops: deps.shops, logger: deps.logger, now, recount });
  const creator = createBatchCreator({ ...deps, now });
  const attachMedia = createAttachMedia(deps);

  async function isMediaInUse(shopId: string, mediaId: string): Promise<boolean> {
    if (!/^[a-f0-9]{24}$/.test(mediaId)) return false;
    const media = new Types.ObjectId(mediaId);
    const shop = new Types.ObjectId(shopId);
    const active = await BatchModel.find({ shopId: shop, status: { $in: ACTIVE_STATUSES } })
      .select({ _id: 1, commonReferenceMediaIds: 1 })
      .lean<Pick<BatchDoc, '_id' | 'commonReferenceMediaIds'>[]>();
    if (active.some((batch) => batch.commonReferenceMediaIds.some((id) => id.equals(media)))) return true;
    if (active.length === 0) return false;
    const used = await BatchItemModel.exists({
      batchId: { $in: active.map((batch) => batch._id) },
      effectiveReferenceMediaIds: media,
    });
    return used !== null;
  }

  const service: BatchesService = {
    createBatch: creator,
    listBatches: queries.listBatches,
    getBatch: queries.getBatch,
    cancel: control.cancel,
    retryFailed: control.retryFailed,
    attachMedia,
    cancelAllForShop: control.cancelAllForShop,
    isMediaInUse,
    getItemContext: items.getItemContext,
    markBatchStarted: items.markBatchStarted,
    markItemPlanning: items.markItemPlanning,
    setCreativePlan: items.setCreativePlan,
    reportJobFinished: (job) => withRetry(() => recount(job.shopId, job.batchId)),
    async purgeShop(shopId) {
      const shop = new Types.ObjectId(shopId);
      await Promise.all([BatchItemModel.deleteMany({ shopId: shop }), BatchModel.deleteMany({ shopId: shop })]);
    },
  };

  return {
    service,
    router: createBatchesRouter(service, deps.requireAuth),
    async ensureIndexes() {
      await Promise.all([BatchModel.createIndexes(), BatchItemModel.createIndexes()]);
    },
  };
}
