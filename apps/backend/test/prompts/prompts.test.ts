import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  PROMPT_MAX_VERSIONS,
  promptDetailSchema,
  promptListResponseSchema,
  promptVersionTextSchema,
  validatePromptText,
  type PromptName,
} from '@rs/shared';
import { AppError } from '../../src/core/errors';
import { PromptStateModel, PromptVersionModel } from '../../src/modules/prompts/models';
import { MONGO_START_TIMEOUT_MS, startTestMongo, type TestMongo } from '../helpers/mongo';
import { createKit, prepareIndexes, SHOP_A, SHOP_B, USER, type Kit } from '../batches/kit';

let mongo: TestMongo;
let kit: Kit;

beforeAll(async () => {
  mongo = await startTestMongo('rs_prompts');
}, MONGO_START_TIMEOUT_MS);

afterAll(async () => {
  await mongo.stop();
});

beforeEach(async () => {
  await mongo.clear();
  kit = createKit();
  await prepareIndexes(kit);
});

const A = { shopId: SHOP_A, userId: USER };
const B = { shopId: SHOP_B, userId: USER };
const service = () => kit.promptStore.service;
const global = (name: PromptName): string => kit.prompts.getPrompt(name).text;

// The global image template with a marker line, so a custom version is recognisable and still valid.
const imageVariant = (marker: string): string => `${global('image.user')}\n\n${marker}`;

async function rejection(promise: Promise<unknown>): Promise<AppError> {
  try {
    await promise;
  } catch (err) {
    if (err instanceof AppError) return err;
    throw err;
  }
  throw new Error('expected the call to be rejected');
}

describe('the global defaults (version 0)', () => {
  it('start every store on version 0 with the file text', async () => {
    const list = promptListResponseSchema.parse(await service().list(SHOP_A));
    expect(list.items.map((item) => item.name)).toEqual(['planner.system', 'image.user', 'video.user']);
    for (const item of list.items) {
      expect(item).toMatchObject({ activeVersion: 0, latestVersion: 0, isCustom: false, updatedAt: null });
      expect(item.placeholders.length).toBeGreaterThan(0);
    }

    const detail = promptDetailSchema.parse(await service().get(SHOP_A, 'image.user'));
    expect(detail.text).toBe(global('image.user'));
    expect(detail.globalText).toBe(global('image.user'));
    expect(detail.versions).toEqual([{ version: 0, source: 'global', createdAt: null, note: null, chars: global('image.user').length, active: true }]);
  });
});

describe('the shipped prompts', () => {
  it.each(['planner.system', 'image.user', 'video.user'] as const)('%s passes the same validation a store edit gets', (name) => {
    // A store starts an edit from the global text, so the global prompt must be a valid prompt itself.
    expect(validatePromptText(name, global(name))).toEqual({ ok: true, text: global(name) });
  });
});

describe('saving versions', () => {
  it('numbers each save, makes it active and keeps the global default untouched', async () => {
    const first = await service().save(A, 'image.user', { text: imageVariant('FIRST'), note: 'first try' });
    expect(first).toMatchObject({ activeVersion: 1, latestVersion: 1, isCustom: true });
    expect(first.text).toContain('FIRST');
    expect(first.globalText).toBe(global('image.user'));

    const second = await service().save(A, 'image.user', { text: imageVariant('SECOND') });
    expect(second).toMatchObject({ activeVersion: 2, latestVersion: 2 });
    expect(second.versions.map((entry) => [entry.version, entry.active, entry.note])).toEqual([
      [2, true, null],
      [1, false, 'first try'],
      [0, false, null],
    ]);
    expect(global('image.user')).not.toContain('FIRST');
  });

  it('keeps a prompt per name: editing one leaves the others on the global default', async () => {
    await service().save(A, 'image.user', { text: imageVariant('X') });
    const list = await service().list(SHOP_A);
    expect(list.items.map((item) => [item.name, item.activeVersion])).toEqual([
      ['planner.system', 0],
      ['image.user', 1],
      ['video.user', 0],
    ]);
    expect(list.items.find((item) => item.name === 'image.user')?.updatedAt).not.toBeNull();
  });

  it('does not add a version when the text is already the active one, or equals the global default while on it', async () => {
    await service().save(A, 'image.user', { text: imageVariant('SAME') });
    const again = await service().save(A, 'image.user', { text: `${imageVariant('SAME')}\r\n\r\n` });
    expect(again).toMatchObject({ activeVersion: 1, latestVersion: 1 });

    const untouched = await service().save(A, 'video.user', { text: global('video.user') });
    expect(untouched).toMatchObject({ activeVersion: 0, latestVersion: 0 });
    expect(await PromptVersionModel.countDocuments({ name: 'video.user' })).toBe(0);
  });

  it('stores a trimmed note and drops an empty one', async () => {
    const withNote = await service().save(A, 'image.user', { text: imageVariant('N1'), note: '  warmer light  ' });
    expect(withNote.versions.find((entry) => entry.version === 1)?.note).toBe('warmer light');
    const empty = await service().save(A, 'image.user', { text: imageVariant('N2'), note: '   ' });
    expect(empty.versions.find((entry) => entry.version === 2)?.note).toBeNull();
  });

  it('hands out distinct numbers to saves that run at the same time', async () => {
    const results = await Promise.all(
      [1, 2, 3, 4, 5].map((n) => service().save(A, 'image.user', { text: imageVariant(`PARALLEL ${n}`) })),
    );
    expect(results.length).toBe(5);
    const stored = await PromptVersionModel.find({ name: 'image.user' }).sort({ version: 1 }).lean();
    expect(stored.map((doc) => doc.version)).toEqual([1, 2, 3, 4, 5]);
    expect((await service().get(SHOP_A, 'image.user')).latestVersion).toBe(5);
  });

  it('refuses a save past the version cap and says how to get unstuck', async () => {
    await PromptStateModel.create({ shopId: SHOP_A, name: 'image.user', activeVersion: 0, latestVersion: PROMPT_MAX_VERSIONS, updatedAt: new Date() });
    const error = await rejection(service().save(A, 'image.user', { text: imageVariant('ONE MORE') }));
    expect(error.code).toBe('shop_limit');
    expect(error.message).toContain(String(PROMPT_MAX_VERSIONS));
  });
});

describe('validation', () => {
  it.each([
    ['an unknown placeholder', 'Make {{shot.prompt}} with {{nope}} and {{plan.product.mustPreserve}}', 'Unknown placeholder {{nope}}'],
    ['a missing required placeholder', 'Make a picture of {{shot.prompt}}', 'Missing required placeholder {{plan.product.mustPreserve}}'],
    ['a malformed placeholder', 'Make {{ shot prompt }} and {{shot.prompt}} {{plan.product.mustPreserve}}', 'malformed'],
    ['an empty prompt', '   ', 'cannot be empty'],
  ])('rejects %s with the reasons in details.errors', async (_label, text, expected) => {
    const error = await rejection(service().save(A, 'image.user', { text }));
    expect(error.code).toBe('validation_failed');
    const errors = (error.details as { errors: string[] }).errors;
    expect(errors.join(' ')).toContain(expected);
    expect(await PromptVersionModel.countDocuments()).toBe(0);
  });

  it('requires the planner counts and the style guidance', async () => {
    const error = await rejection(service().save(A, 'planner.system', { text: 'Plan something nice.' }));
    const errors = (error.details as { errors: string[] }).errors.join(' ');
    expect(errors).toContain('{{imageCount}}');
    expect(errors).toContain('{{videoCount}}');
    expect(errors).toContain('{{styleGuidance}}');
  });
});

describe('going back and forth', () => {
  it('activates an earlier version, then a later one, and resets to the global default', async () => {
    await service().save(A, 'image.user', { text: imageVariant('V1') });
    await service().save(A, 'image.user', { text: imageVariant('V2') });
    await service().save(A, 'image.user', { text: imageVariant('V3') });

    const back = await service().activate(A, 'image.user', 1);
    expect(back).toMatchObject({ activeVersion: 1, latestVersion: 3, isCustom: true });
    expect(back.text).toContain('V1');
    expect(back.versions.filter((entry) => entry.active).map((entry) => entry.version)).toEqual([1]);

    const forward = await service().activate(A, 'image.user', 3);
    expect(forward.text).toContain('V3');

    const reset = await service().activate(A, 'image.user', 0);
    expect(reset).toMatchObject({ activeVersion: 0, latestVersion: 3, isCustom: false, updatedAt: null });
    expect(reset.text).toBe(global('image.user'));
    expect(reset.versions.map((entry) => entry.version)).toEqual([3, 2, 1, 0]);

    // The history survives a reset; saving continues from the highest number.
    const next = await service().save(A, 'image.user', { text: imageVariant('V4') });
    expect(next).toMatchObject({ activeVersion: 4, latestVersion: 4 });
  });

  it('answers not_found for a version the store never saved', async () => {
    const error = await rejection(service().activate(A, 'image.user', 7));
    expect(error.code).toBe('not_found');
    expect((await rejection(service().getVersion(SHOP_A, 'image.user', 7))).code).toBe('not_found');
  });

  it('reads any version, including the global default', async () => {
    await service().save(A, 'image.user', { text: imageVariant('READ ME'), note: 'n' });
    const one = promptVersionTextSchema.parse(await service().getVersion(SHOP_A, 'image.user', 1));
    expect(one).toMatchObject({ version: 1, source: 'store', note: 'n', active: true });
    expect(one.text).toContain('READ ME');
    const zero = await service().getVersion(SHOP_A, 'image.user', 0);
    expect(zero).toMatchObject({ version: 0, source: 'global', active: false, text: global('image.user') });
  });
});

describe('stores are separate', () => {
  it('never shows or changes another store prompts', async () => {
    await service().save(A, 'image.user', { text: imageVariant('ONLY A') });

    const b = await service().get(SHOP_B, 'image.user');
    expect(b).toMatchObject({ activeVersion: 0, latestVersion: 0 });
    expect(b.text).toBe(global('image.user'));
    expect((await rejection(service().activate(B, 'image.user', 1))).code).toBe('not_found');
    expect((await rejection(service().getVersion(SHOP_B, 'image.user', 1))).code).toBe('not_found');

    const bSaved = await service().save(B, 'image.user', { text: imageVariant('ONLY B') });
    expect(bSaved.activeVersion).toBe(1);
    expect((await service().get(SHOP_A, 'image.user')).text).toContain('ONLY A');
    expect((await service().get(SHOP_A, 'image.user')).text).not.toContain('ONLY B');
  });

  it('removes a store prompts on redact and leaves the others', async () => {
    await service().save(A, 'image.user', { text: imageVariant('A') });
    await service().save(B, 'image.user', { text: imageVariant('B') });
    await service().purgeShop(SHOP_A);
    expect((await service().get(SHOP_A, 'image.user')).activeVersion).toBe(0);
    expect((await service().get(SHOP_B, 'image.user')).activeVersion).toBe(1);
  });
});

describe('what generation reads', () => {
  it('resolves version 0 to the live global prompt and a store version to its own text and hash', async () => {
    await service().save(A, 'image.user', { text: imageVariant('RESOLVE') });
    const globalPrompt = await service().resolve(SHOP_A, 'image.user', 0);
    expect(globalPrompt).toMatchObject({ version: 0, source: 'global', text: global('image.user'), hash: kit.prompts.getPrompt('image.user').version });
    const custom = await service().resolve(SHOP_A, 'image.user', 1);
    expect(custom).toMatchObject({ version: 1, source: 'store' });
    expect(custom.text).toContain('RESOLVE');
    expect(custom.hash).toMatch(/^[a-f0-9]{12}$/);
    expect(custom.hash).not.toBe(globalPrompt.hash);
  });

  it('falls back to the global default for a version that is missing instead of failing the job', async () => {
    const resolved = await service().resolve(SHOP_A, 'image.user', 9);
    expect(resolved).toMatchObject({ version: 0, source: 'global' });
  });

  it('reports the active version of every prompt', async () => {
    await service().save(A, 'planner.system', { text: global('planner.system') + '\n\nExtra.' });
    await service().save(A, 'video.user', { text: global('video.user') + ' Extra.' });
    await service().activate(A, 'video.user', 0);
    expect(await service().activeRefs(SHOP_A)).toEqual({ planner: 1, image: 0, video: 0 });
    expect(await service().activeRefs(SHOP_B)).toEqual({ planner: 0, image: 0, video: 0 });
  });
});

describe('HTTP API', () => {
  it('lists, saves, reads and activates through /prompts', async () => {
    const list = await kit.api().get('/prompts');
    expect(list.status).toBe(200);
    expect(promptListResponseSchema.parse(list.body).items).toHaveLength(3);

    const saved = await kit.api().put('/prompts/image.user').send({ text: imageVariant('HTTP'), note: 'via api' });
    expect(saved.status).toBe(200);
    expect(promptDetailSchema.parse(saved.body)).toMatchObject({ name: 'image.user', activeVersion: 1 });

    const version = await kit.api().get('/prompts/image.user/versions/1');
    expect(version.status).toBe(200);
    expect(promptVersionTextSchema.parse(version.body).note).toBe('via api');

    const reset = await kit.api().post('/prompts/image.user/activate').send({ version: 0 });
    expect(reset.status).toBe(200);
    expect(reset.body.activeVersion).toBe(0);
  });

  it('answers 400 with details.errors for a bad template and 404 for an unknown name or version', async () => {
    const bad = await kit.api().put('/prompts/image.user').send({ text: 'no placeholders at all' });
    expect(bad.status).toBe(400);
    expect(bad.body.error.code).toBe('validation_failed');
    expect(bad.body.error.details.errors.join(' ')).toContain('{{shot.prompt}}');

    expect((await kit.api().get('/prompts/not.a.prompt')).status).toBe(400);
    expect((await kit.api().post('/prompts/image.user/activate').send({ version: 5 })).status).toBe(404);
    expect((await kit.api().post('/prompts/image.user/activate').send({ version: -1 })).status).toBe(400);
  });

  it('keeps stores apart over HTTP', async () => {
    await kit.api(SHOP_A).put('/prompts/image.user').send({ text: imageVariant('HTTP A') });
    const b = await kit.api(SHOP_B).get('/prompts/image.user');
    expect(b.body.activeVersion).toBe(0);
    expect((await kit.api(SHOP_B).get('/prompts/image.user/versions/1')).status).toBe(404);
  });
});
