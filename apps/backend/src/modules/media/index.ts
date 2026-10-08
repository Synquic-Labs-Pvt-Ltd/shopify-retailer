import type { RequestHandler, Router } from 'express';
import type {
  GenerationConfig,
  MediaObject,
  MediaRole,
  MediaScope,
  MediaStatus,
  MediaType,
  StorageProvider,
  UploadFileRequest,
  UploadTarget,
} from '@rs/shared';
import type { Logger } from '../../core/logger';
import type { ShopifyAdminClient } from '../shopify';

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
  // Rejects with StorageUploadError (code shopify_upload_failed, retryable flag) when the output cannot be stored.
  persistOutput(input: PersistOutputInput): Promise<MediaObject>;
  delete(shopId: string, mediaId: string): Promise<void>;
}

// One product and the outputs to add to it.
export interface AttachTarget {
  productGid: string;
  mediaIds: string[];
}

export interface AttachResult {
  productGid: string;
  attached: string[];
  alreadyAttached: string[];
  failed: { mediaId: string; message: string }[];
}

export interface MediaService {
  readonly storage: StorageDriver;
  // Adds ready outputs to the Shopify products they were made for. Never throws for one product's failure (it is in
  // the result); throws for a shop-level failure (login needed, Shopify unreachable or throttling).
  attachToProducts(shopId: string, targets: AttachTarget[]): Promise<AttachResult[]>;
  // Assets that belong to the shop. Callers check role and status themselves.
  getAssets(shopId: string, mediaIds: string[]): Promise<MediaAssetRecord[]>;
  getObjects(shopId: string, mediaIds: string[], options?: { refresh?: boolean }): Promise<MediaObject[]>;
  purgeShop(shopId: string): Promise<void>;
  // DELETE /media/:id. References only. Throws not_found, forbidden (an output) or in_use (409).
  deleteReference(shopId: string, mediaId: string): Promise<void>;
}

export interface MediaModuleOptions {
  admin: ShopifyAdminClient;
  // Verifies the bearer JWT and sets req.auth (auth module).
  requireAuth: RequestHandler;
  getConfig: () => GenerationConfig;
  logger: Logger;
  // True while a non-terminal batch uses the asset. Supplied by the batches module; defaults to false.
  isMediaInUse?: (shopId: string, mediaId: string) => Promise<boolean>;
  // Test seams. fetchImpl does the server side POST to the staged target.
  fetchImpl?: typeof fetch;
  now?: () => Date;
  // Waits between fileStatus polls in persistOutput. Defaults to setTimeout.
  sleep?: (ms: number) => Promise<void>;
}

export interface MediaModule {
  service: MediaService;
  // Paths relative to /api/v1: POST /media/uploads, POST /media/:id/complete, GET /media, DELETE /media/:id.
  router: Router;
  ensureIndexes(): Promise<void>;
}

export { StorageUploadError } from './errors';
export { createMediaModule } from './module';
