import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { MONGO_START_TIMEOUT_MS, startTestMongo, type TestMongo } from '../helpers/mongo';
import { BatchModel } from '../../src/modules/batches/models';
import { JobModel } from '../../src/modules/queue/models';
import { createKit, prepareIndexes, SHOP_A, USER, type Kit } from '../batches/kit';
import { failWith, invalidArgument } from '../batches/scripted-ai';

let mongo: TestMongo;
let kit: Kit;

beforeAll(async () => {
  mongo = await startTestMongo('rs_prompts_generation');
}, MONGO_START_TIMEOUT_MS);

afterAll(async () => {
  await mongo.stop();
});

beforeEach(async () => {
  await mongo.clear();
  kit = createKit();
  await prepareIndexes(kit);
});

const actor = { shopId: SHOP_A, userId: USER };
const globalText = (name: 'planner.system' | 'image.user' | 'video.user'): string => kit.prompts.getPrompt(name).text;

async function newBatch(): Promise<string> {
  const common = kit.reference();
  const summary = await kit.create({ products: kit.products(1).map((productGid) => ({ productGid })), commonReferenceMediaIds: [common] });
  return summary.id;
}

const jobsOf = (batchId: string) => JobModel.find({ batchId }).lean();

describe('a batch records the prompt versions it used', () => {
  it('on the global defaults: revision 0 on every job and on every output', async () => {
    const batchId = await newBatch();
    const done = await kit.driveToTerminal(batchId);
    expect(done.status).toBe('completed');

    const jobs = await jobsOf(batchId);
    expect(jobs).toHaveLength(4);
    for (const job of jobs) {
      expect(job.promptRevision).toBe(0);
      const name = job.type === 'plan' ? 'planner.system' : job.type === 'image' ? 'image.user' : 'video.user';
      expect(job.promptVersion).toBe(kit.prompts.getPrompt(name).version);
    }
    const batch = await BatchModel.findById(batchId).lean();
    expect(batch?.configSnapshot.promptRefs).toEqual({ planner: 0, image: 0, video: 0 });
    expect(kit.media.persisted.map((input) => input.prompts)).toEqual(
      expect.arrayContaining([{ planner: 0, render: 0 }]),
    );
    expect(kit.media.persisted.every((input) => input.prompts?.planner === 0 && input.prompts.render === 0)).toBe(true);
  });

  it("uses the store's own version of each prompt and records it", async () => {
    await kit.promptStore.service.save(actor, 'image.user', { text: `${globalText('image.user')}\n\nSTORE IMAGE PROMPT` });
    await kit.promptStore.service.save(actor, 'image.user', { text: `${globalText('image.user')}\n\nSTORE IMAGE PROMPT TWO` });
    await kit.promptStore.service.save(actor, 'planner.system', { text: `${globalText('planner.system')}\n\nSTORE PLANNER PROMPT` });

    const batchId = await newBatch();
    await kit.driveToTerminal(batchId);

    const jobs = await jobsOf(batchId);
    const plan = jobs.find((job) => job.type === 'plan');
    const images = jobs.filter((job) => job.type === 'image');
    const video = jobs.find((job) => job.type === 'video');
    expect(plan).toMatchObject({ promptRevision: 1 });
    expect(plan?.renderedPrompt).toContain('STORE PLANNER PROMPT');
    expect(images).toHaveLength(2);
    for (const image of images) {
      expect(image.promptRevision).toBe(2);
      expect(image.renderedPrompt).toContain('STORE IMAGE PROMPT TWO');
    }
    expect(images[0]?.promptVersion).not.toBe(kit.prompts.getPrompt('image.user').version);
    expect(video).toMatchObject({ promptRevision: 0 });
    expect(video?.renderedPrompt).not.toContain('STORE');

    // The model really received the store's text.
    expect(kit.ai.calls.plan[0]?.systemPrompt).toContain('STORE PLANNER PROMPT');
    const imageText = (kit.ai.calls.image[0]?.parts ?? []).flatMap((part) => (part.kind === 'text' ? [part.text] : [])).join('\n');
    expect(imageText).toContain('STORE IMAGE PROMPT TWO');

    const byType = (type: 'image' | 'video') => kit.media.persisted.filter((input) => input.mediaType === type).map((input) => input.prompts);
    expect(byType('image')).toEqual([
      { planner: 1, render: 2 },
      { planner: 1, render: 2 },
    ]);
    expect(byType('video')).toEqual([{ planner: 1, render: 0 }]);
  });

  it('freezes the versions at creation: later edits and a reset do not change a batch in flight or its retries', async () => {
    await kit.promptStore.service.save(actor, 'image.user', { text: `${globalText('image.user')}\n\nFROZEN V1` });
    const batchId = await newBatch();

    await kit.promptStore.service.save(actor, 'image.user', { text: `${globalText('image.user')}\n\nEDITED AFTER` });
    await kit.promptStore.service.activate(actor, 'image.user', 0);
    await kit.driveToTerminal(batchId);

    const images = (await jobsOf(batchId)).filter((job) => job.type === 'image');
    for (const image of images) {
      expect(image.promptRevision).toBe(1);
      expect(image.renderedPrompt).toContain('FROZEN V1');
    }

    // A batch created now follows the store's current choice (the global default again).
    const next = await newBatch();
    await kit.driveToTerminal(next);
    const nextImage = (await jobsOf(next)).find((job) => job.type === 'image');
    expect(nextImage?.promptRevision).toBe(0);
  });

  it('leaves the planner revision empty on outputs made from the fallback plan', async () => {
    await kit.promptStore.service.save(actor, 'planner.system', { text: `${globalText('planner.system')}\n\nWILL FAIL` });
    kit.ai.hooks.plan = () => failWith(invalidArgument());
    const batchId = await newBatch();
    const done = await kit.driveToTerminal(batchId);
    expect(done.status).toBe('completed');
    expect(kit.media.persisted.length).toBeGreaterThan(0);
    for (const input of kit.media.persisted) expect(input.prompts).toEqual({ planner: null, render: 0 });
  });

  it('treats a batch created before per-store prompts (no refs in its snapshot) as the global default', async () => {
    await kit.promptStore.service.save(actor, 'image.user', { text: `${globalText('image.user')}\n\nNEW STORE PROMPT` });
    const batchId = await newBatch();
    await BatchModel.updateOne({ _id: batchId }, { $unset: { 'configSnapshot.promptRefs': 1 } });

    await kit.driveToTerminal(batchId);

    for (const image of (await jobsOf(batchId)).filter((job) => job.type === 'image')) {
      expect(image.promptRevision).toBe(0);
      expect(image.renderedPrompt).not.toContain('NEW STORE PROMPT');
    }
  });

  it('keeps one store prompts out of another store batches', async () => {
    await kit.promptStore.service.save(actor, 'image.user', { text: `${globalText('image.user')}\n\nONLY SHOP A` });
    const other = kit.reference('b'.repeat(24));
    const [gid] = kit.products(1) as [string];
    const summary = await kit.create({ products: [{ productGid: gid }], commonReferenceMediaIds: [other] }, 'b'.repeat(24));
    await kit.driveToTerminal(summary.id, 'b'.repeat(24));
    for (const image of (await jobsOf(summary.id)).filter((job) => job.type === 'image')) {
      expect(image.promptRevision).toBe(0);
      expect(image.renderedPrompt).not.toContain('ONLY SHOP A');
    }
  });
});
