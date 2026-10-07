import { Types } from 'mongoose';
import type { CreativePlan, PlanSource } from '@rs/shared';
import { AppError } from '../../core/errors';
import type { BatchItemContext, BatchesModuleDeps, StoredPlan } from './index';
import { BatchItemModel, BatchModel, type BatchDoc, type BatchItemDoc } from './models';

type ItemDeps = Pick<BatchesModuleDeps, 'media'> & { now: () => Date };

const isObjectId = (id: string): boolean => Types.ObjectId.isValid(id) && /^[a-f0-9]{24}$/.test(id);

// What the generation handlers read and write on batches and items.
export function createItemService(deps: ItemDeps) {
  const { media, now } = deps;

  const notFound = (): AppError => AppError.notFound('Batch item not found');

  async function getItemContext(shopId: string, itemId: string, options: { references?: boolean } = {}): Promise<BatchItemContext> {
    if (!isObjectId(itemId)) throw notFound();
    const item = await BatchItemModel.findOne({ _id: new Types.ObjectId(itemId), shopId: new Types.ObjectId(shopId) }).lean<BatchItemDoc>();
    if (item === null) throw notFound();
    const batch = await BatchModel.findOne({ _id: item.batchId, shopId: item.shopId }).lean<BatchDoc>();
    if (batch === null) throw notFound();

    const effective = item.effectiveReferenceMediaIds.map((id) => id.toHexString());
    const assets = effective.length === 0 || options.references === false ? [] : await media.getAssets(shopId, effective);
    const byId = new Map(assets.map((asset) => [asset.id, asset]));
    const references = effective.flatMap((id) => {
      const asset = byId.get(id);
      return asset !== undefined && asset.role === 'reference' && asset.status === 'ready' ? [asset] : [];
    });

    return {
      shopId,
      createdByUserId: batch.createdByUserId.toHexString(),
      batchId: batch._id.toHexString(),
      itemId: item._id.toHexString(),
      productGid: item.productGid,
      productSnapshot: item.productSnapshot,
      effectiveReferenceMediaIds: effective,
      references,
      referenceMode: item.referenceMode,
      creativePlan: item.creativePlan ?? null,
      planSource: item.planSource ?? null,
      config: batch.configSnapshot,
      cancelRequested: batch.cancelRequestedAt != null,
    };
  }

  async function markBatchStarted(shopId: string, batchId: string): Promise<void> {
    await BatchModel.updateOne(
      { _id: new Types.ObjectId(batchId), shopId: new Types.ObjectId(shopId), status: 'queued' },
      { $set: { status: 'running', startedAt: now() } },
    );
  }

  async function markItemPlanning(shopId: string, itemId: string): Promise<void> {
    await BatchItemModel.updateOne(
      { _id: new Types.ObjectId(itemId), shopId: new Types.ObjectId(shopId), status: 'pending' },
      { $set: { status: 'planning' } },
    );
  }

  async function setCreativePlan(shopId: string, itemId: string, plan: CreativePlan, source: PlanSource): Promise<StoredPlan> {
    const filter = { _id: new Types.ObjectId(itemId), shopId: new Types.ObjectId(shopId) };
    const written = await BatchItemModel.findOneAndUpdate(
      { ...filter, $or: [{ creativePlan: null }, { creativePlan: { $exists: false } }] },
      { $set: { creativePlan: plan, planSource: source } },
      { returnDocument: 'after' },
    ).lean<BatchItemDoc>();
    const stored = written ?? (await BatchItemModel.findOne(filter).lean<BatchItemDoc>());
    if (stored?.creativePlan == null || stored.planSource == null) throw notFound();
    return { plan: stored.creativePlan, source: stored.planSource };
  }

  return { getItemContext, markBatchStarted, markItemPlanning, setCreativePlan };
}
