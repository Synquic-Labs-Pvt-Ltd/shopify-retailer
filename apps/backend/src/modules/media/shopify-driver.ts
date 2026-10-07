import { Types } from 'mongoose';
import type { MediaObject, UploadFileRequest, UploadTarget } from '@rs/shared';
import { AppError } from '../../core/errors';
import type { DriverDeps } from './deps';
import { deleteFile } from './files-api';
import { toObjectId } from './mapper';
import { MediaAssetModel } from './models';
import { persistOutput } from './persist';
import { refreshStatus } from './refresh';
import { completeUpload, createUploadTargets } from './uploads';
import type { MediaActor, PersistOutputInput, StorageDriver } from './index';

// Shopify Files through the Admin GraphQL API (SPEC 8.6). The steps live in uploads.ts, refresh.ts and
// persist.ts; this class only binds them to the injected dependencies.
export class ShopifyStorageDriver implements StorageDriver {
  readonly provider = 'shopify' as const;
  // Persists in flight in this process, so two calls for one job share one upload.
  private readonly inFlight = new Map<string, Promise<MediaObject>>();

  constructor(private readonly deps: DriverDeps) {}

  createUploadTargets(actor: MediaActor, files: UploadFileRequest[]): Promise<UploadTarget[]> {
    return createUploadTargets(this.deps, actor, files);
  }

  completeUpload(actor: MediaActor, mediaId: string): Promise<MediaObject> {
    return completeUpload(this.deps, actor, mediaId);
  }

  refreshStatus(shopId: string, mediaIds: string[]): Promise<MediaObject[]> {
    return refreshStatus(this.deps, shopId, mediaIds);
  }

  persistOutput(input: PersistOutputInput): Promise<MediaObject> {
    const key = `${input.shopId}:${input.sourceJobId}`;
    const running = this.inFlight.get(key);
    if (running !== undefined) return running;
    const started = persistOutput(this.deps, input).finally(() => this.inFlight.delete(key));
    this.inFlight.set(key, started);
    return started;
  }

  // Deletes the Shopify file and marks the asset deleted. Deleting twice is fine.
  async delete(shopId: string, mediaId: string): Promise<void> {
    const id = toObjectId(mediaId);
    const asset = id === null ? null : await MediaAssetModel.findOne({ _id: id, shopId: new Types.ObjectId(shopId) });
    if (asset === null) throw AppError.notFound('Media not found');
    if (asset.status === 'deleted') return;

    const fileGid = asset.shopify?.fileGid;
    if (fileGid !== undefined) await deleteFile(this.deps.admin, shopId, fileGid);
    await MediaAssetModel.updateOne({ _id: asset._id }, { $set: { status: 'deleted', deletedAt: this.deps.now() } });
  }
}
