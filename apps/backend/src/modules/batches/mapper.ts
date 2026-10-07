import type { BatchSummary } from '@rs/shared';
import type { BatchDoc } from './models';

export function toSummary(doc: BatchDoc): BatchSummary {
  const { counts } = doc;
  return {
    id: doc._id.toHexString(),
    status: doc.status,
    counts: {
      products: counts.products,
      jobsTotal: counts.jobsTotal,
      jobsSucceeded: counts.jobsSucceeded,
      jobsFailed: counts.jobsFailed,
      jobsCancelled: counts.jobsCancelled,
      imagesReady: counts.imagesReady,
      videosReady: counts.videosReady,
    },
    createdAt: doc.createdAt.toISOString(),
    finishedAt: doc.finishedAt?.toISOString() ?? null,
    coverImageUrl: doc.coverImageUrl,
    configSnapshot: { outputs: doc.configSnapshot.outputs },
  };
}

export function isDuplicateKeyError(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: unknown }).code === 11000;
}
