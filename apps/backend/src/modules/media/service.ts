import { Types } from 'mongoose';
import type { MediaObject } from '@rs/shared';
import { AppError } from '../../core/errors';
import { inRequestedOrder, toAssetRecord, toMediaObject, toObjectIds } from './mapper';
import { MediaAssetModel, type MediaAssetDoc } from './models';
import type { MediaAssetRecord, MediaService, StorageDriver } from './index';

export interface MediaServiceOptions {
  storage: StorageDriver;
  attachToProducts: MediaService['attachToProducts'];
  // Supplied by the batches module: true while a non-terminal batch uses the asset.
  isMediaInUse: (shopId: string, mediaId: string) => Promise<boolean>;
}

async function findOwned(shopId: string, mediaIds: string[]): Promise<MediaAssetDoc[]> {
  const ids = toObjectIds(mediaIds);
  if (ids.length === 0) return [];
  const docs = await MediaAssetModel.find({ _id: { $in: ids }, shopId: new Types.ObjectId(shopId) }).lean<MediaAssetDoc[]>();
  return inRequestedOrder(mediaIds, docs);
}

export function createMediaService(options: MediaServiceOptions): MediaService {
  const { storage, isMediaInUse, attachToProducts } = options;

  return {
    storage,
    attachToProducts,

    async getAssets(shopId: string, mediaIds: string[]): Promise<MediaAssetRecord[]> {
      return (await findOwned(shopId, mediaIds)).map(toAssetRecord);
    },

    async getObjects(shopId: string, mediaIds: string[], getOptions?: { refresh?: boolean }): Promise<MediaObject[]> {
      if (getOptions?.refresh === true) return storage.refreshStatus(shopId, mediaIds);
      return (await findOwned(shopId, mediaIds)).map(toMediaObject);
    },

    // References only; outputs are not deletable in cycle 1 (SPEC 8.6).
    async deleteReference(shopId: string, mediaId: string): Promise<void> {
      const [asset] = await findOwned(shopId, [mediaId]);
      if (asset === undefined) throw AppError.notFound('Media not found');
      if (asset.role !== 'reference') throw AppError.forbidden('Outputs cannot be deleted');
      if (asset.status !== 'deleted' && (await isMediaInUse(shopId, mediaId))) {
        throw AppError.inUse('The reference is used by a batch that is still running');
      }
      await storage.delete(shopId, mediaId);
    },

    // shop/redact: only our records go. The files in the merchant's Shopify store are left alone (SPEC 8.4).
    async purgeShop(shopId: string): Promise<void> {
      await MediaAssetModel.deleteMany({ shopId: new Types.ObjectId(shopId) });
    },
  };
}
