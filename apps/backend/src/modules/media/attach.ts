import { Types } from 'mongoose';
import { AppError } from '../../core/errors';
import type { Logger } from '../../core/logger';
import type { ShopifyAdminClient } from '../shopify';
import { attachFilesToProduct } from './files-api';
import { toObjectIds } from './mapper';
import { MediaAssetModel, type MediaAssetDoc } from './models';
import type { AttachResult, AttachTarget } from './index';

export const ATTACH_DENIED_MESSAGE =
  'Shopify did not allow adding files to products. Open the app from the Shopify admin and approve any permission request, then try again.';

interface AttacherDeps {
  admin: ShopifyAdminClient;
  logger: Logger;
  now: () => Date;
}

// How many products are updated at once. Shopify throttles by query cost and the admin client backs off, so a small
// number keeps a big batch quick without hammering the shop.
const CONCURRENCY = 3;

async function attachOne(deps: AttacherDeps, shopId: string, target: AttachTarget): Promise<AttachResult> {
  const result: AttachResult = { productGid: target.productGid, attached: [], alreadyAttached: [], failed: [] };
  const ids = toObjectIds(target.mediaIds);
  const docs = ids.length === 0 ? [] : await MediaAssetModel.find({ _id: { $in: ids }, shopId: new Types.ObjectId(shopId) }).lean<MediaAssetDoc[]>();
  const found = new Set(docs.map((doc) => doc._id.toHexString()));
  for (const mediaId of target.mediaIds) {
    if (!found.has(mediaId)) result.failed.push({ mediaId, message: 'The output no longer exists' });
  }

  const pending: { id: string; fileGid: string }[] = [];
  for (const doc of docs) {
    const id = doc._id.toHexString();
    if (doc.role !== 'output' || doc.productGid !== target.productGid) {
      result.failed.push({ mediaId: id, message: 'The output does not belong to this product' });
    } else if (doc.status !== 'ready' || doc.shopify?.fileGid === undefined) {
      result.failed.push({ mediaId: id, message: 'The output is not ready yet' });
    } else if (doc.attachedAt !== undefined) {
      result.alreadyAttached.push(id);
    } else {
      pending.push({ id, fileGid: doc.shopify.fileGid });
    }
  }
  if (pending.length === 0) return result;

  try {
    const outcome = await attachFilesToProduct(deps.admin, shopId, pending.map((file) => file.fileGid), target.productGid);
    if (outcome.ok) {
      await MediaAssetModel.updateMany({ _id: { $in: pending.map((file) => new Types.ObjectId(file.id)) } }, { $set: { attachedAt: deps.now() } });
      result.attached.push(...pending.map((file) => file.id));
    } else {
      deps.logger.warn({ shopId, productGid: target.productGid, code: outcome.code }, 'Shopify refused to add files to a product');
      result.failed.push(...pending.map((file) => ({ mediaId: file.id, message: outcome.message })));
    }
  } catch (err) {
    // A denied scope is the same for every product, but it is reported per product so each row says what happened.
    if (err instanceof AppError && err.code === 'forbidden') {
      deps.logger.warn({ shopId, productGid: target.productGid }, 'Shopify denied adding files to a product');
      result.failed.push(...pending.map((file) => ({ mediaId: file.id, message: ATTACH_DENIED_MESSAGE })));
    } else {
      throw err;
    }
  }
  return result;
}

export function createAttacher(deps: AttacherDeps) {
  return async function attachToProducts(shopId: string, targets: AttachTarget[]): Promise<AttachResult[]> {
    const results = new Array<AttachResult>(targets.length);
    let next = 0;
    const worker = async (): Promise<void> => {
      for (;;) {
        const index = next;
        next += 1;
        const target = targets[index];
        if (target === undefined) return;
        results[index] = await attachOne(deps, shopId, target);
      }
    };
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, targets.length) }, worker));
    return results;
  };
}
