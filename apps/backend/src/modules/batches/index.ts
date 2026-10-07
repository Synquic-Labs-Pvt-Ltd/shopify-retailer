import type {
  BatchConfigSnapshot,
  BatchDetail,
  BatchListQuery,
  BatchListResponse,
  BatchSummary,
  CreateBatchRequest,
  CreativePlan,
  JobType,
  PlanSource,
  ProductSnapshot,
  ReferenceMode,
} from '@rs/shared';

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
  referenceMode: ReferenceMode;
  creativePlan: CreativePlan | null;
  planSource: PlanSource | null;
  config: BatchConfigSnapshot;
}

export interface JobFinishedReport {
  shopId: string;
  batchId: string;
  itemId: string;
  jobId: string;
  type: JobType;
  status: 'succeeded' | 'failed' | 'cancelled';
  outputMediaId: string | null;
}

export interface BatchesService {
  createBatch(actor: BatchActor, input: CreateBatchRequest): Promise<BatchSummary>;
  listBatches(shopId: string, query: BatchListQuery): Promise<BatchListResponse>;
  getBatch(shopId: string, batchId: string): Promise<BatchDetail>;
  cancelBatch(shopId: string, batchId: string): Promise<BatchSummary>;
  retryFailed(shopId: string, batchId: string): Promise<BatchSummary>;
  // True when a non-terminal batch uses the media as a reference (the DELETE /media guard).
  isReferenceInUse(shopId: string, mediaId: string): Promise<boolean>;
  getItemContext(shopId: string, itemId: string): Promise<BatchItemContext>;
  savePlan(shopId: string, itemId: string, plan: CreativePlan, source: PlanSource): Promise<void>;
  // Atomically increments item and batch counters and recomputes statuses (SPEC 10.5).
  reportJobFinished(report: JobFinishedReport): Promise<void>;
  // shop/redact: deletes batches and batch items of the shop.
  purgeShop(shopId: string): Promise<void>;
}
