import type {
  MediaObject,
  MediaRole,
  MediaScope,
  MediaStatus,
  MediaType,
  StorageProvider,
  UploadFileRequest,
  UploadTarget,
} from '@rs/shared';

export interface MediaActor {
  shopId: string;
  userId: string;
}

// Internal view of a media_assets document. The API shape is MediaObject.
export interface MediaAssetRecord {
  id: string;
  shopId: string;
  role: MediaRole;
  mediaType: MediaType;
  status: MediaStatus;
  filename: string;
  mimeType: string;
  fileSize: number;
  url: string | null;
  previewUrl: string | null;
  width: number | null;
  height: number | null;
  durationSec: number | null;
  scope: MediaScope | null;
  productGid: string | null;
  batchId: string | null;
  batchItemId: string | null;
  shotTitle: string | null;
  createdAt: Date;
}

export interface PersistOutputInput {
  shopId: string;
  createdByUserId: string;
  batchId: string;
  batchItemId: string;
  // Idempotency key: persisting the same job twice returns the first result.
  sourceJobId: string;
  productGid: string;
  mediaType: MediaType;
  mimeType: string;
  bytes: Uint8Array;
  filename: string;
  alt: string;
  shotTitle: string;
}

export interface StorageDriver {
  readonly provider: StorageProvider;
  createUploadTargets(actor: MediaActor, files: UploadFileRequest[]): Promise<UploadTarget[]>;
  completeUpload(actor: MediaActor, mediaId: string): Promise<MediaObject>;
  // Lazy status refresh for assets still processing (at most once every 3 seconds per asset).
  refreshStatus(shopId: string, mediaIds: string[]): Promise<MediaObject[]>;
  persistOutput(input: PersistOutputInput): Promise<MediaObject>;
  delete(shopId: string, mediaId: string): Promise<void>;
}

export interface MediaService {
  readonly storage: StorageDriver;
  // Assets that belong to the shop. Callers check role and status themselves.
  getAssets(shopId: string, mediaIds: string[]): Promise<MediaAssetRecord[]>;
  getObjects(shopId: string, mediaIds: string[], options?: { refresh?: boolean }): Promise<MediaObject[]>;
  purgeShop(shopId: string): Promise<void>;
}
