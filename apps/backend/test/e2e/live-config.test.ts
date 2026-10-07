import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { batchSummarySchema, meResponseSchema, type MediaObject } from '@rs/shared';
import { FAKE_JPEG } from '../../src/modules/ai/fake-media';
import { BatchModel } from '../../src/modules/batches/models';
import { JobModel } from '../../src/modules/queue/models';
import { commonImageSpec, createBatch, defined, getBatch, login, uploadReadyReferences, type ApiClient } from './support/client';
import { MONGO_START_TIMEOUT_MS, startE2e, type E2e } from './support/harness';

const SHOP = 'tuned-store.myshopify.com';
const MARKER = 'GOLDEN HOUR SIGNATURE';

let e2e: E2e;
let client: ApiClient;
let reference: MediaObject;
let gids: string[] = [];

beforeAll(async () => {
  e2e = await startE2e({ dbName: 'rs_e2e_live' });
  e2e.stub.addShop(SHOP);
  client = await login(e2e, SHOP);
  gids = e2e.stub.shop(SHOP).products.map((product) => product.id);
  reference = defined((await uploadReadyReferences(client, [commonImageSpec('common', FAKE_JPEG)]))[0]);
}, MONGO_START_TIMEOUT_MS);

afterAll(async () => {
  await e2e.stop();
});

async function newBatch(productIndex: number): Promise<string> {
  const res = await createBatch(client, { products: [{ productGid: defined(gids[productIndex]) }], commonReferenceMediaIds: [reference.id] });
  expect(res.status).toBe(201);
  return batchSummarySchema.parse(res.body).id;
}

describe('generation settings', () => {
  it('freeze the counts and output parameters of a batch at creation, while new batches follow the edit', async () => {
    const before = await newBatch(0);
    e2e.editConfig((config) => {
      config.outputs.imagesPerProduct = 1;
      config.outputs.videosPerProduct = 0;
      config.image.aspectRatio = '1:1';
      config.video.aspectRatio = '16:9';
    });
    const me = meResponseSchema.parse((await client.get('/api/v1/me')).body);
    expect(me.generation).toMatchObject({ imagesPerProduct: 1, videosPerProduct: 0 });
    const after = await newBatch(1);

    const frozen = defined(await BatchModel.findById(before).lean());
    const fresh = defined(await BatchModel.findById(after).lean());
    expect(frozen.configSnapshot).toMatchObject({ outputs: { imagesPerProduct: 2, videosPerProduct: 1 }, image: { aspectRatio: '3:4' }, video: { aspectRatio: '9:16' } });
    expect(fresh.configSnapshot).toMatchObject({ outputs: { imagesPerProduct: 1, videosPerProduct: 0 }, image: { aspectRatio: '1:1' }, video: { aspectRatio: '16:9' } });
    expect([frozen.counts.jobsTotal, fresh.counts.jobsTotal]).toEqual([4, 2]);

    await e2e.driveBatch(before, { timeoutMs: 60_000 });
    await e2e.driveBatch(after, { timeoutMs: 60_000 });
    await e2e.settle();

    const first = await getBatch(client, before);
    const second = await getBatch(client, after);
    expect(first).toMatchObject({ status: 'completed', counts: { imagesReady: 2, videosReady: 1 }, configSnapshot: { outputs: { imagesPerProduct: 2, videosPerProduct: 1 } } });
    expect(first.items[0]?.outputs.map((output) => output.mediaType)).toEqual(['image', 'image', 'video']);
    expect(second).toMatchObject({ status: 'completed', counts: { imagesReady: 1, videosReady: 0 }, configSnapshot: { outputs: { imagesPerProduct: 1, videosPerProduct: 0 } } });
    expect(second.items[0]?.outputs.map((output) => output.mediaType)).toEqual(['image']);
    expect(second.items[0]?.jobs.map((job) => job.type)).toEqual(['plan', 'image']);

    // The frozen batch rendered its prompts with the frozen parameters (3:4 and 9:16).
    const firstJobs = await JobModel.find({ batchId: before }).lean();
    expect(firstJobs.filter((job) => job.type === 'image').every((job) => job.renderedPrompt?.includes('3:4 aspect ratio'))).toBe(true);
    const secondJobs = await JobModel.find({ batchId: after }).lean();
    expect(secondJobs.filter((job) => job.type === 'image').every((job) => job.renderedPrompt?.includes('1:1 aspect ratio'))).toBe(true);
  }, 90_000);
});

describe('prompts', () => {
  it('hot reload and every job records the version it rendered with', async () => {
    e2e.editConfig((config) => {
      config.outputs.imagesPerProduct = 1;
      config.outputs.videosPerProduct = 1;
    });
    const early = await newBatch(2);
    await e2e.driveBatch(early, { timeoutMs: 60_000 });
    await e2e.settle();
    const earlySnapshot = defined(await BatchModel.findById(early).lean()).configSnapshot.promptVersions;

    e2e.editPrompt('image.user', (text) => `${text}\n\n${MARKER}`);
    e2e.editPrompt('video.user', (text) => `${MARKER} ${text}`);
    const late = await newBatch(3);
    await e2e.driveBatch(late, { timeoutMs: 60_000 });
    await e2e.settle();
    const lateSnapshot = defined(await BatchModel.findById(late).lean()).configSnapshot.promptVersions;

    expect(lateSnapshot.planner).toBe(earlySnapshot.planner);
    expect(lateSnapshot.image).not.toBe(earlySnapshot.image);
    expect(lateSnapshot.video).not.toBe(earlySnapshot.video);
    expect(lateSnapshot.image).toBe(e2e.config.getPromptVersions().image);

    for (const [batchId, snapshot, marked] of [[early, earlySnapshot, false], [late, lateSnapshot, true]] as const) {
      const jobs = await JobModel.find({ batchId }).lean();
      for (const job of jobs) {
        const expected = job.type === 'plan' ? snapshot.planner : job.type === 'image' ? snapshot.image : snapshot.video;
        expect(job.promptVersion).toBe(expected);
        if (job.type !== 'plan') expect(job.renderedPrompt?.includes(MARKER)).toBe(marked);
      }
    }
  }, 120_000);

  it('keeps the last good prompt when an edit is invalid', () => {
    const version = e2e.config.getPromptVersions().image;
    expect(() => e2e.editPrompt('image.user', () => '   ')).toThrow(/rejected/);
    expect(e2e.config.getPromptVersions().image).toBe(version);
  });
});

describe('logs', () => {
  it('only report the rejected prompt edit', () => {
    expect(e2e.problems(['prompt rejected, keeping the last good version', 'released blocked jobs whose dependencies were already terminal'])).toEqual([]);
  });
});
