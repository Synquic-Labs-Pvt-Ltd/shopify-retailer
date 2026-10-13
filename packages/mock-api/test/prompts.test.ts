import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  PROMPT_DEFINITIONS,
  PROMPT_MAX_VERSIONS,
  PROMPT_NAMES,
  promptDetailSchema,
  promptListResponseSchema,
  promptVersionTextSchema,
  validatePromptText,
  type Api,
  type PromptName,
  type PromptsApi,
} from '@rs/shared';
import { createMockPromptsApi, resetMockApi } from '../src';
import { GLOBAL_PROMPT_TEXTS } from '../src/promptStore';
import { objectId, productGid } from '../src/util';
import { advance, cleanup, expectApiError, freshApi, T0 } from './helpers';

let api: Api;
let prompts: PromptsApi;
beforeEach(() => {
  api = freshApi();
  prompts = createMockPromptsApi({ latencyMs: 0 });
});
afterEach(cleanup);

// A valid variant of the global text: same placeholders, one more line.
const variant = (name: PromptName, label: string): string => `${GLOBAL_PROMPT_TEXTS[name]}\nExtra rule: ${label}.`;

describe('global defaults', () => {
  it.each(PROMPT_NAMES)('%s passes the same validation the backend applies', (name) => {
    expect(validatePromptText(name, GLOBAL_PROMPT_TEXTS[name]).ok).toBe(true);
  });

  it('lists the three prompts on the global default', async () => {
    const list = promptListResponseSchema.parse(await prompts.list());
    expect(list.items.map((item) => item.name)).toEqual([...PROMPT_NAMES]);
    for (const item of list.items) {
      expect(item).toMatchObject({ activeVersion: 0, latestVersion: 0, isCustom: false, updatedAt: null });
      expect(item.title).toBe(PROMPT_DEFINITIONS[item.name].title);
      expect(item.placeholders).toEqual(PROMPT_DEFINITIONS[item.name].placeholders);
    }
  });

  it('gives the detail of a prompt with the global text and a single global version', async () => {
    const detail = promptDetailSchema.parse(await prompts.get('image.user'));
    expect(detail.text).toBe(GLOBAL_PROMPT_TEXTS['image.user']);
    expect(detail.globalText).toBe(detail.text);
    expect(detail.versions).toEqual([
      { version: 0, source: 'global', createdAt: null, note: null, chars: detail.text.length, active: true },
    ]);
  });
});

describe('save', () => {
  it('stores the text as version 1, active, and leaves the global text alone', async () => {
    const text = variant('image.user', 'one');
    const detail = promptDetailSchema.parse(await prompts.save('image.user', { text, note: '  warmer light  ' }));
    expect(detail).toMatchObject({
      activeVersion: 1,
      latestVersion: 1,
      isCustom: true,
      updatedAt: T0.toISOString(),
      text,
      globalText: GLOBAL_PROMPT_TEXTS['image.user'],
    });
    expect(detail.versions.map((version) => [version.version, version.active])).toEqual([
      [1, true],
      [0, false],
    ]);
    expect(detail.versions[0]).toMatchObject({
      source: 'store',
      note: 'warmer light',
      chars: text.length,
      createdAt: T0.toISOString(),
    });
  });

  it('numbers the next version latest + 1 and lists the newest first with the global default last', async () => {
    await prompts.save('video.user', { text: variant('video.user', 'one') });
    advance(60_000);
    const second = await prompts.save('video.user', { text: variant('video.user', 'two') });
    expect(second.versions.map((version) => version.version)).toEqual([2, 1, 0]);
    expect(second.versions.map((version) => version.active)).toEqual([true, false, false]);
    expect(second.versions[0]?.createdAt).toBe(new Date(T0.getTime() + 60_000).toISOString());
    expect(second.versions[0]?.note).toBeNull();
    expect(second.updatedAt).toBe(second.versions[0]?.createdAt);
  });

  it('normalizes line endings and trailing whitespace before it stores the text', async () => {
    const raw = `${GLOBAL_PROMPT_TEXTS['video.user']}\r\nAnother line.\r\n\r\n  `;
    const detail = await prompts.save('video.user', { text: raw });
    expect(detail.text).toBe(`${GLOBAL_PROMPT_TEXTS['video.user']}\nAnother line.`);
  });

  it('keeps every prompt on its own history', async () => {
    await prompts.save('planner.system', { text: variant('planner.system', 'a') });
    const list = (await prompts.list()).items;
    expect(list.map((item) => item.activeVersion)).toEqual([1, 0, 0]);
  });

  it('answers 400 validation_failed with the problems in details.errors and changes nothing', async () => {
    const missing = GLOBAL_PROMPT_TEXTS['image.user'].replace('{{shot.prompt}}', 'a shot');
    const error = await expectApiError(prompts.save('image.user', { text: `${missing} {{nope}}` }), 'validation_failed');
    const { errors } = error.details as { errors: string[] };
    expect(errors).toEqual(
      expect.arrayContaining([
        expect.stringContaining('Unknown placeholder {{nope}}'),
        expect.stringContaining('Missing required placeholder {{shot.prompt}}'),
      ]),
    );
    expect(error.message).toBe(errors[0]);
    expect((await prompts.get('image.user')).activeVersion).toBe(0);
  });

  it('rejects an empty prompt and a note that is too long', async () => {
    const empty = await expectApiError(prompts.save('image.user', { text: '   \n' }), 'validation_failed');
    expect(empty.details).toEqual({ errors: ['The prompt cannot be empty.'] });
    const note = 'x'.repeat(201);
    await expectApiError(prompts.save('image.user', { text: variant('image.user', 'n'), note }), 'validation_failed');
  });

  it('treats the text that is already active as a no-op: same detail, no new version', async () => {
    const first = await prompts.save('planner.system', { text: variant('planner.system', 'a') });
    const again = await prompts.save('planner.system', { text: `${first.text}\r\n\r\n`, note: 'ignored' });
    expect(again).toEqual(first);
    expect(again.latestVersion).toBe(1);

    // On the global default, saving the global text creates nothing either.
    const global = await prompts.save('video.user', { text: GLOBAL_PROMPT_TEXTS['video.user'] });
    expect(global).toMatchObject({ activeVersion: 0, latestVersion: 0, isCustom: false });
  });

  it('saves a text equal to an older version that is not the active one', async () => {
    const one = variant('video.user', 'one');
    await prompts.save('video.user', { text: one });
    await prompts.save('video.user', { text: variant('video.user', 'two') });
    const third = await prompts.save('video.user', { text: one });
    expect(third).toMatchObject({ activeVersion: 3, latestVersion: 3, text: one });
  });

  it('answers 429 shop_limit once the store holds the maximum number of versions', async () => {
    for (let index = 1; index <= PROMPT_MAX_VERSIONS; index += 1) {
      await prompts.save('video.user', { text: variant('video.user', String(index)) });
    }
    const full = await prompts.get('video.user');
    expect(full.latestVersion).toBe(PROMPT_MAX_VERSIONS);
    expect(full.versions).toHaveLength(PROMPT_MAX_VERSIONS + 1);

    await expectApiError(prompts.save('video.user', { text: variant('video.user', 'one too many') }), 'shop_limit');
    // The cap blocks saving only: older versions can still be activated, and the no-op still answers.
    expect((await prompts.activate('video.user', { version: 5 })).activeVersion).toBe(5);
    expect((await prompts.get('video.user')).latestVersion).toBe(PROMPT_MAX_VERSIONS);
  });
});

describe('activate and reset', () => {
  it('switches back and forth between versions and keeps them all', async () => {
    const one = variant('image.user', 'one');
    const two = variant('image.user', 'two');
    await prompts.save('image.user', { text: one });
    await prompts.save('image.user', { text: two });

    const backToOne = await prompts.activate('image.user', { version: 1 });
    expect(backToOne).toMatchObject({ activeVersion: 1, latestVersion: 2, isCustom: true, text: one });
    expect(backToOne.versions.map((version) => version.active)).toEqual([false, true, false]);
    expect(backToOne.updatedAt).toBe(backToOne.versions[1]?.createdAt);

    const forward = await prompts.activate('image.user', { version: 2 });
    expect(forward).toMatchObject({ activeVersion: 2, text: two });
  });

  it('resets to the global default with version 0 and keeps the custom versions in the history', async () => {
    await prompts.save('image.user', { text: variant('image.user', 'one') });
    const reset = promptDetailSchema.parse(await prompts.activate('image.user', { version: 0 }));
    expect(reset).toMatchObject({
      activeVersion: 0,
      latestVersion: 1,
      isCustom: false,
      updatedAt: null,
      text: GLOBAL_PROMPT_TEXTS['image.user'],
    });
    expect(reset.versions.map((version) => [version.version, version.active])).toEqual([
      [1, false],
      [0, true],
    ]);

    // The next save continues the numbering instead of reusing a number.
    const next = await prompts.save('image.user', { text: variant('image.user', 'two') });
    expect(next.activeVersion).toBe(2);
  });

  it('answers 404 not_found for a version that does not exist', async () => {
    await expectApiError(prompts.activate('image.user', { version: 3 }), 'not_found');
    await expectApiError(prompts.getVersion('image.user', 1), 'not_found');
  });
});

describe('versions', () => {
  it('reads the text of the global default and of a saved version', async () => {
    const text = variant('planner.system', 'a');
    await prompts.save('planner.system', { text, note: 'first' });
    await prompts.save('planner.system', { text: variant('planner.system', 'b') });

    const saved = promptVersionTextSchema.parse(await prompts.getVersion('planner.system', 1));
    expect(saved).toMatchObject({ version: 1, source: 'store', note: 'first', active: false, text, chars: text.length });

    const global = promptVersionTextSchema.parse(await prompts.getVersion('planner.system', 0));
    expect(global).toMatchObject({
      version: 0,
      source: 'global',
      createdAt: null,
      active: false,
      text: GLOBAL_PROMPT_TEXTS['planner.system'],
    });
  });
});

describe('batch outputs', () => {
  const body = {
    idempotencyKey: '00000000-0000-4000-8000-000000000001',
    products: [{ productGid: productGid(0) }],
    commonReferenceMediaIds: [objectId(1)],
  };

  it('record the global default (0) when nothing was edited', async () => {
    const { id } = await api.batches.create(body);
    advance(10_000);
    const detail = await api.batches.get(id);
    const outputs = detail.items.flatMap((item) => item.outputs);
    expect(outputs.length).toBeGreaterThan(0);
    for (const output of outputs) expect(output.prompts).toEqual({ planner: 0, render: 0 });
  });

  it('record the versions that were active when the batch was created', async () => {
    await prompts.save('planner.system', { text: variant('planner.system', 'p') });
    await prompts.save('image.user', { text: variant('image.user', 'i1') });
    await prompts.save('image.user', { text: variant('image.user', 'i2') });

    const { id } = await api.batches.create(body);
    advance(10_000);
    const detail = await api.batches.get(id);
    const outputs = detail.items.flatMap((item) => item.outputs);
    expect(outputs.filter((output) => output.mediaType === 'image').map((output) => output.prompts)).toEqual([
      { planner: 1, render: 2 },
      { planner: 1, render: 2 },
    ]);

    // Later edits do not rewrite what a finished output was made with.
    await prompts.activate('image.user', { version: 1 });
    const later = (await api.batches.get(id)).items.flatMap((item) => item.outputs);
    expect(later.map((output) => output.prompts)).toEqual(outputs.map((output) => output.prompts));
  });

  it('give the retried video the video prompt that is active at the retry', async () => {
    const { id } = await api.batches.create(body);
    advance(10_000);
    expect((await api.batches.get(id)).status).toBe('completed_with_errors');

    await prompts.save('video.user', { text: variant('video.user', 'retry') });
    await api.batches.retryFailed(id);
    advance(6_000);
    const outputs = (await api.batches.get(id)).items.flatMap((item) => item.outputs);
    const video = outputs.find((output) => output.mediaType === 'video');
    expect(video?.prompts).toEqual({ planner: 0, render: 1 });
    expect(outputs.find((output) => output.mediaType === 'image')?.prompts).toEqual({ planner: 0, render: 0 });
  });
});

describe('reset of the mock', () => {
  it('forgets every saved version', async () => {
    await prompts.save('image.user', { text: variant('image.user', 'one') });
    resetMockApi();
    expect((await prompts.get('image.user')).latestVersion).toBe(0);
  });
});
