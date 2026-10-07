import type { QueueConfig } from '@rs/shared';
import { backoffMs } from './backoff';
import { JobModel, type JobDoc } from './models';
import type { Settled } from './settle';

const BATCH_LIMIT = 100;

// SPEC 11.1: running jobs whose lease expired go back to queued with backoff while attempts remain,
// otherwise they fail with lease_expired. Returns what changed so the caller can release dependents
// and report terminal jobs.
export async function reapExpiredLeases(now: Date, config: QueueConfig, random: () => number): Promise<Settled[]> {
  const expired = await JobModel.find({ status: 'running', 'lease.expiresAt': { $lt: now } })
    .limit(BATCH_LIMIT)
    .lean<JobDoc[]>();

  const results: Settled[] = [];
  for (const job of expired) {
    // Same guard as the query, so a heartbeat or outcome that lands in between wins.
    const fence: Record<string, unknown> = { _id: job._id, status: 'running', 'lease.expiresAt': { $lt: now }, attempts: job.attempts };
    const error = { code: 'lease_expired', message: 'Worker lease expired', retryable: true, at: now };

    if (job.attempts < job.maxAttempts) {
      const runAt = new Date(now.getTime() + backoffMs(job.attempts, config, random));
      const doc = await JobModel.findOneAndUpdate(
        fence,
        { $set: { status: 'queued', runAt, error }, $unset: { lease: 1 } },
        { returnDocument: 'after' },
      ).lean<JobDoc>();
      if (doc !== null) results.push({ doc, terminal: false });
      continue;
    }

    const doc = await JobModel.findOneAndUpdate(
      fence,
      { $set: { status: 'failed', finishedAt: now, error: { ...error, retryable: false } }, $unset: { lease: 1 } },
      { returnDocument: 'after' },
    ).lean<JobDoc>();
    if (doc !== null) results.push({ doc, terminal: true });
  }
  return results;
}
