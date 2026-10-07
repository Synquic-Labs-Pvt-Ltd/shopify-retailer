import { Types } from 'mongoose';
import type { GenerationConfig, JobStatus } from '@rs/shared';
import type { JobStore, NewJob, QueueJob } from './index';
import { toQueueJob } from './mapper';
import { JobModel, type JobDoc } from './models';

export interface JobStoreOptions {
  getConfig: () => GenerationConfig;
  now: () => Date;
}

const CANCELLABLE_BY_BATCH: JobStatus[] = ['blocked', 'queued', 'awaiting_operation'];
const NON_TERMINAL: JobStatus[] = ['blocked', 'queued', 'running', 'awaiting_operation'];

function cancelUpdate(now: Date) {
  return {
    $set: {
      status: 'cancelled' as const,
      finishedAt: now,
      error: { code: 'cancelled' as const, message: 'Cancelled', retryable: false, at: now },
    },
    $unset: { lease: 1 },
  };
}

export function createJobStore(options: JobStoreOptions): JobStore {
  const { getConfig, now } = options;

  return {
    async enqueue(job: NewJob): Promise<QueueJob> {
      const at = now();
      const dependsOn = (job.dependsOn ?? []).map((id) => new Types.ObjectId(id));
      const doc = await JobModel.create({
        shopId: new Types.ObjectId(job.shopId),
        batchId: new Types.ObjectId(job.batchId),
        batchItemId: new Types.ObjectId(job.batchItemId),
        type: job.type,
        lane: job.lane,
        status: dependsOn.length > 0 ? 'blocked' : 'queued',
        dependsOn,
        outputIndex: job.outputIndex,
        priority: job.priority ?? 0,
        runAt: at,
        attempts: 0,
        maxAttempts: getConfig().queue.maxAttempts,
        deferrals: 0,
        createdAt: at,
        updatedAt: at,
      });
      return toQueueJob(doc.toObject());
    },

    async get(jobId: string): Promise<QueueJob | null> {
      if (!Types.ObjectId.isValid(jobId)) return null;
      const doc = await JobModel.findById(jobId).lean<JobDoc>();
      return doc === null ? null : toQueueJob(doc);
    },

    async listByBatch(shopId: string, batchId: string): Promise<QueueJob[]> {
      const docs = await JobModel.find({ shopId: new Types.ObjectId(shopId), batchId: new Types.ObjectId(batchId) })
        .sort({ createdAt: 1, _id: 1 })
        .lean<JobDoc[]>();
      return docs.map(toQueueJob);
    },

    async cancelByBatch(shopId: string, batchId: string): Promise<number> {
      const result = await JobModel.updateMany(
        { shopId: new Types.ObjectId(shopId), batchId: new Types.ObjectId(batchId), status: { $in: CANCELLABLE_BY_BATCH } },
        cancelUpdate(now()),
      );
      return result.modifiedCount;
    },

    async cancelByShop(shopId: string): Promise<number> {
      const result = await JobModel.updateMany(
        { shopId: new Types.ObjectId(shopId), status: { $in: NON_TERMINAL } },
        cancelUpdate(now()),
      );
      return result.modifiedCount;
    },

    async requeueFailed(shopId: string, batchId: string): Promise<number> {
      const at = now();
      const result = await JobModel.updateMany(
        { shopId: new Types.ObjectId(shopId), batchId: new Types.ObjectId(batchId), status: 'failed' },
        {
          $set: { status: 'queued', attempts: 0, deferrals: 0, runAt: at, requeuedAt: at },
          $unset: { error: 1, finishedAt: 1, startedAt: 1, operation: 1, lease: 1 },
        },
      );
      return result.modifiedCount;
    },

    async purgeShop(shopId: string): Promise<void> {
      await JobModel.deleteMany({ shopId: new Types.ObjectId(shopId) });
    },
  };
}
