import type { MediaObject, UploadFileRequest, UploadTarget } from '@rs/shared';
import { AppError } from '../../core/errors';
import type { MediaActor, PersistOutputInput, StorageDriver } from './index';

// Reserved for a later cycle (SPEC 8.6): the same interface, every method rejects with not_implemented.
// config storage.driver must stay "shopify".
export class S3StorageDriver implements StorageDriver {
  readonly provider = 's3' as const;

  createUploadTargets(_actor: MediaActor, _files: UploadFileRequest[]): Promise<UploadTarget[]> {
    return this.notImplemented();
  }

  completeUpload(_actor: MediaActor, _mediaId: string): Promise<MediaObject> {
    return this.notImplemented();
  }

  refreshStatus(_shopId: string, _mediaIds: string[]): Promise<MediaObject[]> {
    return this.notImplemented();
  }

  persistOutput(_input: PersistOutputInput): Promise<MediaObject> {
    return this.notImplemented();
  }

  delete(_shopId: string, _mediaId: string): Promise<void> {
    return this.notImplemented();
  }

  private notImplemented(): Promise<never> {
    return Promise.reject(AppError.notImplemented('The S3 storage driver is not implemented'));
  }
}
