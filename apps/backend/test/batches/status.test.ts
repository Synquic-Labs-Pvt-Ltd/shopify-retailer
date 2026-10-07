import { describe, expect, it } from 'vitest';
import type { BatchStatus, ItemStatus, JobStatus, JobType } from '@rs/shared';
import { deriveBatch, deriveItem, type JobFact } from '../../src/modules/batches/status';

const fact = (type: JobType, status: JobStatus, outputIndex: number | null = null, mediaId: string | null = null): JobFact => ({
  type,
  status,
  outputIndex,
  mediaId,
});

const ok = (type: 'image' | 'video', index: number): JobFact => fact(type, 'succeeded', index, `m-${type}-${index}`);

// plan, 2 images, 1 video
function itemJobs(plan: JobStatus, images: [JobStatus, JobStatus], video: JobStatus): JobFact[] {
  return [
    fact('plan', plan),
    fact('image', images[0], 0, images[0] === 'succeeded' ? 'm-image-0' : null),
    fact('image', images[1], 1, images[1] === 'succeeded' ? 'm-image-1' : null),
    fact('video', video, 0, video === 'succeeded' ? 'm-video-0' : null),
  ];
}

const state = (status: ItemStatus = 'pending', planned = false) => ({ status, planned, expectedJobs: 4 });

describe('deriveItem (SPEC 10.5)', () => {
  it.each<{ name: string; jobs: JobFact[]; from?: ItemStatus; planned?: boolean; status: ItemStatus | null }>([
    { name: 'plan not started leaves pending alone', jobs: itemJobs('queued', ['blocked', 'blocked'], 'blocked'), status: null },
    { name: 'plan running leaves planning alone', jobs: itemJobs('running', ['blocked', 'blocked'], 'blocked'), from: 'planning', status: null },
    { name: 'plan done, outputs open: generating', jobs: itemJobs('succeeded', ['queued', 'running'], 'blocked'), from: 'planning', status: 'generating' },
    { name: 'plan failed, outputs open: generating', jobs: itemJobs('failed', ['queued', 'queued'], 'queued'), from: 'planning', status: 'generating' },
    { name: 'a requeued plan with a stored plan and open outputs: generating', jobs: itemJobs('queued', ['queued', 'queued'], 'queued'), from: 'completed', planned: true, status: 'generating' },
    { name: 'a requeued plan without outputs open: planning', jobs: itemJobs('queued', ['succeeded', 'succeeded'], 'succeeded'), from: 'completed', planned: true, status: 'planning' },
    { name: 'all succeeded: completed', jobs: itemJobs('succeeded', ['succeeded', 'succeeded'], 'succeeded'), status: 'completed' },
    { name: 'some outputs succeeded: partial', jobs: itemJobs('succeeded', ['succeeded', 'failed'], 'succeeded'), status: 'partial' },
    { name: 'no output succeeded: failed', jobs: itemJobs('succeeded', ['failed', 'failed'], 'failed'), status: 'failed' },
    { name: 'a failed plan does not downgrade complete outputs', jobs: itemJobs('failed', ['succeeded', 'succeeded'], 'succeeded'), status: 'completed' },
    { name: 'failed and cancelled outputs together: cancelled', jobs: itemJobs('failed', ['failed', 'cancelled'], 'failed'), status: 'cancelled' },
    { name: 'cancelled jobs: cancelled, even when some outputs exist', jobs: itemJobs('succeeded', ['succeeded', 'succeeded'], 'cancelled'), status: 'cancelled' },
    { name: 'everything cancelled', jobs: itemJobs('cancelled', ['cancelled', 'cancelled'], 'cancelled'), status: 'cancelled' },
  ])('$name', ({ jobs, from, planned, status }) => {
    expect(deriveItem(jobs, state(from, planned)).status).toBe(status);
  });

  it('is terminal only when every expected job exists and is terminal', () => {
    const partial = itemJobs('succeeded', ['succeeded', 'succeeded'], 'succeeded').slice(0, 3);
    expect(deriveItem(partial, state()).terminal).toBe(false);
    expect(deriveItem(partial, state()).status).toBeNull();
    expect(deriveItem(itemJobs('succeeded', ['succeeded', 'succeeded'], 'succeeded'), state()).terminal).toBe(true);
    expect(deriveItem([], state()).status).toBeNull();
  });

  it('counts jobs and orders outputs: images by index, then videos', () => {
    const jobs = [fact('plan', 'succeeded'), ok('video', 0), ok('image', 1), ok('image', 0), fact('video', 'failed', 1)];
    const derived = deriveItem(jobs, { status: 'generating', planned: true, expectedJobs: 5 });
    expect(derived.counts).toEqual({ succeeded: 4, failed: 1, cancelled: 0 });
    expect(derived.outputMediaIds).toEqual(['m-image-0', 'm-image-1', 'm-video-0']);
  });

  it('is idempotent: deriving twice from the same jobs gives the same answer', () => {
    const jobs = itemJobs('succeeded', ['succeeded', 'failed'], 'succeeded');
    expect(deriveItem(jobs, state())).toEqual(deriveItem(jobs, state()));
  });
});

describe('deriveBatch (SPEC 10.5)', () => {
  const all = (items: ItemStatus[]) => items;
  const jobsFor = (n: number, status: JobStatus, withOutput = false): JobFact[] =>
    Array.from({ length: n }, (_unused, i) => fact('image', status, i, withOutput ? `m${i}` : null));

  it.each<{ name: string; jobs: JobFact[]; items: ItemStatus[]; from: BatchStatus; status: BatchStatus | null }>([
    { name: 'nothing started stays queued', jobs: jobsFor(4, 'queued'), items: all(['pending']), from: 'queued', status: null },
    { name: 'work in flight stays running', jobs: [...jobsFor(2, 'succeeded', true), ...jobsFor(2, 'queued')], items: all(['generating']), from: 'running', status: null },
    { name: 'all items completed: completed', jobs: jobsFor(4, 'succeeded', true), items: all(['completed', 'completed']), from: 'running', status: 'completed' },
    { name: 'a failure with outputs: completed_with_errors', jobs: [...jobsFor(3, 'succeeded', true), ...jobsFor(1, 'failed')], items: all(['completed', 'partial']), from: 'running', status: 'completed_with_errors' },
    { name: 'a failed item next to a completed one: completed_with_errors', jobs: [...jobsFor(2, 'succeeded', true), ...jobsFor(2, 'failed')], items: all(['completed', 'failed']), from: 'running', status: 'completed_with_errors' },
    { name: 'zero outputs: failed', jobs: jobsFor(4, 'failed'), items: all(['failed', 'failed']), from: 'running', status: 'failed' },
    { name: 'a cancelled item: cancelled', jobs: [...jobsFor(2, 'succeeded', true), ...jobsFor(2, 'cancelled')], items: all(['completed', 'cancelled']), from: 'running', status: 'cancelled' },
    { name: 'a finished batch with requeued jobs runs again', jobs: [...jobsFor(2, 'succeeded', true), ...jobsFor(1, 'queued')], items: all(['generating']), from: 'completed_with_errors', status: 'running' },
  ])('$name', ({ jobs, items, from, status }) => {
    expect(deriveBatch(jobs, items, { status: from, expectedJobs: jobs.length }).status).toBe(status);
  });

  it('derives counters from the jobs, counting an output only when it has media', () => {
    const jobs = [
      fact('plan', 'succeeded'),
      ok('image', 0),
      fact('image', 'succeeded', 1, null),
      ok('video', 0),
      fact('video', 'failed', 1),
      fact('image', 'cancelled', 2),
    ];
    const derived = deriveBatch(jobs, ['partial'], { status: 'running', expectedJobs: 6 });
    expect(derived.counts).toEqual({ jobsSucceeded: 4, jobsFailed: 1, jobsCancelled: 1, imagesReady: 1, videosReady: 1 });
    expect(derived.terminal).toBe(true);
  });

  it('waits for jobs that are not created yet', () => {
    const jobs = jobsFor(2, 'succeeded', true);
    expect(deriveBatch(jobs, ['completed'], { status: 'running', expectedJobs: 4 })).toMatchObject({ terminal: false, status: null });
    expect(deriveBatch(jobs, ['completed'], { status: 'completed', expectedJobs: 4 })).toMatchObject({ terminal: false, status: 'running' });
  });
});
