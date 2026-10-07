import { Types } from 'mongoose';
import type { MediaObject } from '@rs/shared';
import type { DriverDeps } from './deps';
import { describeError } from './errors';
import { failedUpdate, readyUpdate } from './file-updates';
import { queryFileStates, type FileTarget } from './files-api';
import { inRequestedOrder, toMediaObject, toObjectIds } from './mapper';
import { MediaAssetModel, type MediaAssetDoc } from './models';

// At most one fileStatus query per asset in this window (SPEC 8.6).
export const REFRESH_MIN_INTERVAL_MS = 3_000;

// Marks the assets that are due as checked and returns them. The atomic per-asset update means two
// concurrent requests never both query Shopify for the same asset. Most polls find nothing due, so a
// cheap read comes first.
async function claimDueAssets(deps: DriverDeps, shopId: Types.ObjectId, ids: Types.ObjectId[]): Promise<MediaAssetDoc[]> {
  const at = deps.now();
  const cutoff = new Date(at.getTime() - REFRESH_MIN_INTERVAL_MS);
  const due = {
    shopId,
    storageProvider: 'shopify' as const,
    status: 'processing' as const,
    'shopify.fileGid': { $exists: true },
    $or: [{ 'shopify.lastCheckedAt': { $exists: false } }, { 'shopify.lastCheckedAt': { $lte: cutoff } }],
  };
  const candidates = await MediaAssetModel.find({ _id: { $in: ids }, ...due }).select('_id').lean();
  const claimed = await Promise.all(
    candidates.map((candidate) =>
      MediaAssetModel.findOneAndUpdate({ _id: candidate._id, ...due }, { $set: { 'shopify.lastCheckedAt': at } }).lean<MediaAssetDoc>(),
    ),
  );
  return claimed.filter((doc) => doc !== null);
}

async function refreshDue(deps: DriverDeps, shopId: string, due: MediaAssetDoc[]): Promise<void> {
  const targets: FileTarget[] = due.flatMap((doc) => (doc.shopify?.fileGid === undefined ? [] : [{ fileGid: doc.shopify.fileGid, mediaType: doc.mediaType }]));
  const states = await queryFileStates(deps.admin, shopId, targets);
  const at = deps.now();
  await Promise.all(
    due.map(async (doc) => {
      const state = doc.shopify?.fileGid === undefined ? undefined : states.get(doc.shopify.fileGid);
      if (state === undefined || state.status === 'processing') return;
      const update = state.status === 'ready' ? readyUpdate(state, at) : failedUpdate(state);
      // The status guard keeps a concurrent delete from being overwritten.
      await MediaAssetModel.updateOne({ _id: doc._id, status: 'processing' }, update);
    }),
  );
}

// Lazy refresh (SPEC 8.6): re-queries Shopify for assets still processing and returns the current
// state of every requested asset of the shop. A Shopify outage never fails the read; the assets just
// keep their last known state.
export async function refreshStatus(deps: DriverDeps, shopId: string, mediaIds: string[]): Promise<MediaObject[]> {
  const ids = toObjectIds(mediaIds);
  const owner = new Types.ObjectId(shopId);
  if (ids.length === 0) return [];

  try {
    const due = await claimDueAssets(deps, owner, ids);
    if (due.length > 0) await refreshDue(deps, shopId, due);
  } catch (err) {
    deps.logger.warn({ shopId, error: describeError(err) }, 'media status refresh failed');
  }

  const docs = await MediaAssetModel.find({ _id: { $in: ids }, shopId: owner }).lean();
  return inRequestedOrder(mediaIds, docs).map(toMediaObject);
}
