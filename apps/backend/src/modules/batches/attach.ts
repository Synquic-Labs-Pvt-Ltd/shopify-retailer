import { Types } from 'mongoose';
import type { AttachMediaItemResult, AttachMediaResponse } from '@rs/shared';
import { AppError } from '../../core/errors';
import type { BatchesModuleDeps } from './index';
import { BatchItemModel, type BatchItemDoc } from './models';
import { findBatch } from './queries';

type AttachDeps = Pick<BatchesModuleDeps, 'media' | 'shops'>;

const isObjectId = (id: string): boolean => /^[a-f0-9]{24}$/.test(id);

// Adds the outputs of a batch to the products they were generated for. Items without ready outputs are skipped.
// The result has one row per item that has outputs, so the client can say what happened product by product.
export function createAttachMedia(deps: AttachDeps) {
  return async function attachMedia(shopId: string, batchId: string, itemIds?: string[]): Promise<AttachMediaResponse> {
    await deps.shops.requireActive(shopId);
    const batch = await findBatch(shopId, batchId);

    if (itemIds !== undefined && !itemIds.every(isObjectId)) throw AppError.validation('Invalid item id');
    const filter = {
      shopId: new Types.ObjectId(shopId),
      batchId: batch._id,
      ...(itemIds === undefined ? {} : { _id: { $in: itemIds.map((id) => new Types.ObjectId(id)) } }),
    };
    const items = await BatchItemModel.find(filter)
      .select({ productGid: 1, outputMediaIds: 1 })
      .sort({ _id: 1 })
      .lean<Pick<BatchItemDoc, '_id' | 'productGid' | 'outputMediaIds'>[]>();
    if (itemIds !== undefined && items.length !== new Set(itemIds).size) throw AppError.notFound('Batch item not found');

    const withOutputs = items.filter((item) => item.outputMediaIds.length > 0);
    const results = await deps.media.attachToProducts(
      shopId,
      withOutputs.map((item) => ({ productGid: item.productGid, mediaIds: item.outputMediaIds.map((id) => id.toHexString()) })),
    );

    const rows: AttachMediaItemResult[] = withOutputs.map((item, index) => {
      const result = results[index];
      const failed = result?.failed ?? [];
      return {
        itemId: item._id.toHexString(),
        productGid: item.productGid,
        attached: result?.attached.length ?? 0,
        alreadyAttached: result?.alreadyAttached.length ?? 0,
        failed: failed.length,
        error: failed[0]?.message ?? null,
      };
    });
    const sum = (pick: (row: AttachMediaItemResult) => number): number => rows.reduce((total, row) => total + pick(row), 0);
    return { items: rows, attached: sum((row) => row.attached), alreadyAttached: sum((row) => row.alreadyAttached), failed: sum((row) => row.failed) };
  };
}
