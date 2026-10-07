import { Types } from 'mongoose';
import {
  createBatchRequestSchema,
  laneKey,
  type BatchConfigSnapshot,
  type BatchSummary,
  type CreateBatchInput,
  type GenerationConfig,
  type ProductSnapshot,
} from '@rs/shared';
import { AppError } from '../../core/errors';
import { parseWith } from '../../core/http';
import type { BatchActor, BatchesModuleDeps } from './index';
import { assertAdmission } from './admission';
import { isDuplicateKeyError, toSummary } from './mapper';
import { BatchItemModel, BatchModel, type BatchDoc, type BatchItemDoc } from './models';
import { allReferenceIds, assertUsableReferences, resolveRequest, type ResolvedProduct } from './references';

type CreateDeps = Pick<BatchesModuleDeps, 'getConfig' | 'getPromptVersions' | 'queue' | 'catalog' | 'media' | 'shops' | 'logger'> & {
  now: () => Date;
};

// The generation settings that apply to this batch for good (SPEC 14.7). Lanes and queue settings stay live.
export function freezeConfig(config: GenerationConfig, promptVersions: BatchConfigSnapshot['promptVersions']): BatchConfigSnapshot {
  return structuredClone({
    outputs: config.outputs,
    provider: config.provider,
    models: config.models,
    locations: config.locations,
    image: config.image,
    video: config.video,
    promptVersions: { planner: promptVersions.planner, image: promptVersions.image, video: promptVersions.video },
  });
}

export function jobsPerProduct(outputs: GenerationConfig['outputs']): number {
  return 1 + outputs.imagesPerProduct + outputs.videosPerProduct;
}

const ids = (values: readonly string[]): Types.ObjectId[] => values.map((value) => new Types.ObjectId(value));

function coverImage(snapshot: ProductSnapshot | undefined): string | null {
  return snapshot?.featuredImageUrl ?? snapshot?.imageUrls[0] ?? null;
}

export function createBatchCreator(deps: CreateDeps) {
  const { queue, catalog, media, shops, logger, now } = deps;

  const findByKey = (shopId: string, idempotencyKey: string) =>
    BatchModel.findOne({ shopId: new Types.ObjectId(shopId), idempotencyKey }).lean<BatchDoc>();

  // Enqueues the plan job and the output jobs that wait for it. No transactions on standalone Mongo, so
  // the caller cleans up when this throws part-way.
  async function enqueueItemJobs(item: BatchItemDoc, config: BatchConfigSnapshot): Promise<number> {
    const base = { shopId: item.shopId.toHexString(), batchId: item.batchId.toHexString(), batchItemId: item._id.toHexString() };
    const plan = await queue.store.enqueue({ ...base, type: 'plan', lane: laneKey(config.provider, config.models.planner) });
    const imageLane = laneKey(config.provider, config.models.image);
    const videoLane = laneKey(config.provider, config.models.video);
    const dependents = [
      ...Array.from({ length: config.outputs.imagesPerProduct }, (_unused, outputIndex) => ({ type: 'image' as const, lane: imageLane, outputIndex })),
      ...Array.from({ length: config.outputs.videosPerProduct }, (_unused, outputIndex) => ({ type: 'video' as const, lane: videoLane, outputIndex })),
    ];
    await Promise.all(dependents.map((job) => queue.store.enqueue({ ...base, ...job, dependsOn: [plan.id] })));
    return 1 + dependents.length;
  }

  // Never leaves orphans silently: whatever was enqueued is cancelled and the batch is marked failed.
  async function abandon(batch: BatchDoc, created: number, cause: unknown): Promise<never> {
    const shopId = batch.shopId.toHexString();
    const at = now();
    logger.error({ err: cause, batchId: batch._id.toHexString() }, 'batch creation failed part-way, cancelling its jobs');
    try {
      await queue.store.cancelByBatch(shopId, batch._id.toHexString());
      await BatchModel.updateOne(
        { _id: batch._id },
        { $set: { status: 'failed', cancelRequestedAt: at, finishedAt: at, 'counts.jobsTotal': created } },
      );
      await BatchItemModel.updateMany({ batchId: batch._id }, { $set: { status: 'failed', finishedAt: at } });
    } catch (cleanupError) {
      logger.error({ err: cleanupError, batchId: batch._id.toHexString() }, 'cannot clean up a batch whose creation failed');
    }
    throw cause instanceof AppError ? cause : AppError.internal('Could not create the batch', cause);
  }

  return async function createBatch(actor: BatchActor, input: CreateBatchInput): Promise<BatchSummary> {
    const request = parseWith(createBatchRequestSchema, input);
    await shops.requireActive(actor.shopId);

    const replay = await findByKey(actor.shopId, request.idempotencyKey);
    if (replay !== null) return toSummary(replay);

    const config = deps.getConfig();
    const resolved = resolveRequest(request, config.references);
    const jobsTotal = resolved.products.length * jobsPerProduct(config.outputs);
    const at = now();
    await assertAdmission(actor.shopId, { products: resolved.products.length, jobs: jobsTotal }, config.batch, at);

    const referenceIds = allReferenceIds(resolved);
    assertUsableReferences(referenceIds, referenceIds.length === 0 ? [] : await media.getAssets(actor.shopId, referenceIds));
    const snapshots = await catalog.snapshotProducts(
      actor.shopId,
      resolved.products.map((product) => product.productGid),
    );

    for (const product of resolved.products) {
      if (!snapshots.has(product.productGid)) throw AppError.notFound(`Product ${product.productGid} was not found`);
    }

    const snapshot = freezeConfig(config, deps.getPromptVersions());
    const shopId = new Types.ObjectId(actor.shopId);
    let batch: BatchDoc;
    try {
      const created = await BatchModel.create({
        shopId,
        createdByUserId: new Types.ObjectId(actor.userId),
        idempotencyKey: request.idempotencyKey,
        status: 'queued',
        configSnapshot: snapshot,
        commonReferenceMediaIds: ids(resolved.common),
        coverImageUrl: coverImage(snapshots.get(resolved.products[0]?.productGid ?? '')),
        counts: { products: resolved.products.length, jobsTotal },
        createdAt: at,
        updatedAt: at,
      });
      batch = created.toObject();
    } catch (err) {
      // A concurrent request with the same key won the race: its batch is the answer.
      if (isDuplicateKeyError(err)) {
        const winner = await findByKey(actor.shopId, request.idempotencyKey);
        if (winner !== null) return toSummary(winner);
      }
      throw err;
    }

    let enqueued = 0;
    try {
      const items = resolved.products.map((product) => toItemDoc(batch, product, snapshots, snapshot, at));
      await BatchItemModel.insertMany(items);
      for (const item of items) enqueued += await enqueueItemJobs(item, snapshot);
    } catch (err) {
      return abandon(batch, enqueued, err);
    }
    logger.info({ batchId: batch._id.toHexString(), shopId: actor.shopId, products: resolved.products.length, jobs: jobsTotal }, 'batch created');
    return toSummary(batch);
  };
}

function toItemDoc(
  batch: BatchDoc,
  product: ResolvedProduct,
  snapshots: Map<string, ProductSnapshot>,
  config: BatchConfigSnapshot,
  at: Date,
): BatchItemDoc {
  const productSnapshot = snapshots.get(product.productGid);
  if (productSnapshot === undefined) throw AppError.internal(`Missing snapshot for ${product.productGid}`);
  return {
    _id: new Types.ObjectId(),
    batchId: batch._id,
    shopId: batch.shopId,
    productGid: product.productGid,
    productSnapshot,
    ownReferenceMediaIds: ids(product.own),
    effectiveReferenceMediaIds: ids(product.effective),
    referenceMode: product.mode,
    status: 'pending',
    creativePlan: null,
    outputMediaIds: [],
    counts: { jobsTotal: jobsPerProduct(config.outputs), succeeded: 0, failed: 0, cancelled: 0 },
    statsApplied: 0,
    createdAt: at,
    updatedAt: at,
  };
}
