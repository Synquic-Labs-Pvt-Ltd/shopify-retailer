import type { RequestHandler, Router } from 'express';
import type {
  BatchConfigSnapshot,
  BatchDetail,
  BatchListQuery,
  BatchListResponse,
  BatchSummary,
  CreateBatchInput,
  CreativePlan,
  GenerationConfig,
  PlanSource,
  ProductSnapshot,
  ReferenceMode,
} from '@rs/shared';
import type { PromptVersions } from '../../core/config';
import type { Logger } from '../../core/logger';
import type { CatalogService } from '../catalog';
import type { MediaAssetRecord, MediaService } from '../media';
import type { QueueJob, QueueService } from '../queue';
import type { Governor } from '../ratelimit';
import type { ShopsService } from '../shops';

export interface BatchActor {
  shopId: string;
  userId: string;
}

// Everything a generation handler needs about one batch item.
export interface BatchItemContext {
  shopId: string;
  createdByUserId: string;
  batchId: string;
  itemId: string;
  productGid: string;
  productSnapshot: ProductSnapshot;
  effectiveReferenceMediaIds: string[];
  // The effective references that are still ready and usable, own references first.
  references: MediaAssetRecord[];
  referenceMode: ReferenceMode;
  creativePlan: CreativePlan | null;
  planSource: PlanSource | null;
  // Frozen at batch creation (SPEC 14.7).
  config: BatchConfigSnapshot;
  // The batch was cancelled: handlers must not start new provider work.
  cancelRequested: boolean;
}

export interface StoredPlan {
  plan: CreativePlan;
  source: PlanSource;
}

export interface BatchesService {
  // 422 references_required, 429 shop_limit, 400 validation_failed. The same idempotencyKey returns the
  // batch created by the first call.
  createBatch(actor: BatchActor, input: CreateBatchInput): Promise<BatchSummary>;
  listBatches(shopId: string, query: BatchListQuery): Promise<BatchListResponse>;
  getBatch(shopId: string, batchId: string): Promise<BatchDetail>;
  // Queued, blocked and awaiting_operation jobs are cancelled; running jobs finish and keep their output.
  cancel(actor: BatchActor, batchId: string): Promise<BatchSummary>;
  // Requeues the failed jobs of a finished batch.
  retryFailed(actor: BatchActor, batchId: string): Promise<BatchSummary>;
  // Uninstall: cancels every non-terminal batch of the shop. Returns the number of batches.
  cancelAllForShop(shopId: string): Promise<number>;
  // True when a non-terminal batch uses the media as a common or effective reference (DELETE /media guard).
  isMediaInUse(shopId: string, mediaId: string): Promise<boolean>;
  // Handler support. Throws AppError not_found for an unknown item. references: false skips loading the
  // reference assets (they stay empty) for handlers that do not use them.
  getItemContext(shopId: string, itemId: string, options?: { references?: boolean }): Promise<BatchItemContext>;
  markBatchStarted(shopId: string, batchId: string): Promise<void>;
  markItemPlanning(shopId: string, itemId: string): Promise<void>;
  // First write wins. Returns the plan that is stored afterwards.
  setCreativePlan(shopId: string, itemId: string, plan: CreativePlan, source: PlanSource): Promise<StoredPlan>;
  // The queue's onTerminal listener (container.onJobTerminal). Idempotent and safe to call concurrently.
  reportJobFinished(job: QueueJob): Promise<void>;
  // shop/redact: deletes batches and batch items of the shop.
  purgeShop(shopId: string): Promise<void>;
}

export interface BatchesModuleDeps {
  // Read at every use: admission limits, reference caps and lanes are live. The batch snapshot is frozen.
  getConfig: () => GenerationConfig;
  getPromptVersions: () => PromptVersions;
  queue: Pick<QueueService, 'store'>;
  governor: Pick<Governor, 'listPaused'>;
  catalog: Pick<CatalogService, 'snapshotProducts'>;
  media: Pick<MediaService, 'getAssets' | 'getObjects'>;
  shops: Pick<ShopsService, 'requireActive'>;
  // Verifies the bearer token and sets req.auth (auth module's AuthService.requireAuth).
  requireAuth: RequestHandler;
  logger: Logger;
  now?: () => Date;
}

export interface BatchesModule {
  service: BatchesService;
  // Mount at /api/v1: POST /batches, GET /batches, GET /batches/:id, POST /batches/:id/cancel and
  // /batches/:id/retry-failed.
  router: Router;
  // Creates the batches and batch_items indexes. Mongoose also does this on connect.
  ensureIndexes(): Promise<void>;
}

export { createBatchesModule } from './module';
