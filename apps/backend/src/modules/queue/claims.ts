import type { JobType } from '@rs/shared';
import { JobModel, type JobDoc } from './models';

// SPEC 11.1: one atomic findOneAndUpdate. _id is a final tiebreak so equal timestamps stay deterministic.
export function claimNext(lane: string, types: JobType[], owner: string, now: Date, leaseMs: number): Promise<JobDoc | null> {
  return JobModel.findOneAndUpdate(
    { status: 'queued', lane, runAt: { $lte: now }, type: { $in: types } },
    {
      $set: {
        status: 'running',
        'lease.owner': owner,
        'lease.expiresAt': new Date(now.getTime() + leaseMs),
        startedAt: now,
      },
      $inc: { attempts: 1 },
    },
    { sort: { priority: -1, runAt: 1, createdAt: 1, _id: 1 }, returnDocument: 'after' },
  ).lean<JobDoc>();
}

// An awaiting_operation job is claimed for one poll by taking a lease. A job whose poller died is
// claimable again once the lease expires.
export function claimDuePoll(types: JobType[], owner: string, now: Date, leaseMs: number): Promise<JobDoc | null> {
  return JobModel.findOneAndUpdate(
    {
      status: 'awaiting_operation',
      type: { $in: types },
      'operation.nextPollAt': { $lte: now },
      $or: [{ 'lease.expiresAt': null }, { 'lease.expiresAt': { $lte: now } }],
    },
    { $set: { 'lease.owner': owner, 'lease.expiresAt': new Date(now.getTime() + leaseMs) } },
    { sort: { 'operation.nextPollAt': 1 }, returnDocument: 'after' },
  ).lean<JobDoc>();
}

// Heartbeat. False means this instance no longer owns the job (cancelled, reaped or reclaimed).
export async function extendRunLease(job: JobDoc, owner: string, now: Date, leaseMs: number): Promise<boolean> {
  const result = await JobModel.updateOne(
    { _id: job._id, status: 'running', 'lease.owner': owner, attempts: job.attempts },
    { $set: { 'lease.expiresAt': new Date(now.getTime() + leaseMs) } },
  );
  return result.matchedCount > 0;
}
