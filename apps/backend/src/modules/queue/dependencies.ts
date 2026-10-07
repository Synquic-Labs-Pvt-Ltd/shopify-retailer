import { TERMINAL_JOB_STATUSES } from '@rs/shared';
import { JobModel, type JobDoc } from './models';

const TERMINAL = [...TERMINAL_JOB_STATUSES];

async function releaseIfReady(candidate: Pick<JobDoc, '_id' | 'dependsOn'>, now: Date): Promise<boolean> {
  const pending = await JobModel.countDocuments({ _id: { $in: candidate.dependsOn }, status: { $nin: TERMINAL } });
  if (pending > 0) return false;
  // The status guard makes concurrent releases of the same job (two dependencies finishing at once) safe.
  const released = await JobModel.updateOne(
    { _id: candidate._id, status: 'blocked' },
    { $set: { status: 'queued', runAt: now } },
  );
  return released.modifiedCount > 0;
}

// Called after a job became terminal (succeeded, failed or cancelled; a failed dependency still releases).
// Dependents always belong to the same batch item, so the batchItemId index serves the lookup.
export async function releaseDependents(job: Pick<JobDoc, '_id' | 'batchItemId'>, now: Date): Promise<number> {
  const candidates = await JobModel.find({ batchItemId: job.batchItemId, status: 'blocked', dependsOn: job._id })
    .select({ dependsOn: 1 })
    .lean<Pick<JobDoc, '_id' | 'dependsOn'>[]>();
  let released = 0;
  for (const candidate of candidates) {
    if (await releaseIfReady(candidate, now)) released += 1;
  }
  return released;
}

// Repairs blocked jobs whose dependencies are all terminal already: a crash between a job turning
// terminal and its dependents being released, or dependents enqueued after their dependency finished.
export async function releaseOrphanedBlocked(now: Date, limit = 500): Promise<number> {
  const blocked = await JobModel.find({ status: 'blocked' })
    .sort({ createdAt: 1 })
    .limit(limit)
    .select({ dependsOn: 1 })
    .lean<Pick<JobDoc, '_id' | 'dependsOn'>[]>();
  if (blocked.length === 0) return 0;

  const dependencyIds = [...new Set(blocked.flatMap((job) => job.dependsOn.map((id) => id.toHexString())))];
  const pendingDocs = await JobModel.find({ _id: { $in: dependencyIds }, status: { $nin: TERMINAL } })
    .select({ _id: 1 })
    .lean<Pick<JobDoc, '_id'>[]>();
  const pending = new Set(pendingDocs.map((doc) => doc._id.toHexString()));

  let released = 0;
  for (const job of blocked) {
    if (job.dependsOn.some((id) => pending.has(id.toHexString()))) continue;
    const result = await JobModel.updateOne({ _id: job._id, status: 'blocked' }, { $set: { status: 'queued', runAt: now } });
    if (result.modifiedCount > 0) released += 1;
  }
  return released;
}
