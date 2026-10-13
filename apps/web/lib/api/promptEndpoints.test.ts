import { ApiError, type PromptDetail } from '@rs/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { validationErrors } from './errors';
import { promptEndpoints } from './endpoints';
import { queryKeys } from './keys';

vi.mock('@/lib/shopify', () => ({ getSessionToken: async () => 'session-token' }));

const DETAIL: PromptDetail = {
  name: 'image.user',
  title: 'Image shot',
  description: 'The prompt sent to the image model.',
  placeholders: [{ name: 'shot.prompt', required: true, description: 'The planned shot.' }],
  activeVersion: 2,
  latestVersion: 3,
  isCustom: true,
  updatedAt: '2026-03-10T12:00:00.000Z',
  text: 'Shot: {{shot.prompt}}',
  globalText: 'Global {{shot.prompt}}',
  versions: [
    { version: 3, source: 'store', createdAt: '2026-03-10T13:00:00.000Z', note: null, chars: 10, active: false },
    { version: 2, source: 'store', createdAt: '2026-03-10T12:00:00.000Z', note: 'calmer', chars: 21, active: true },
    { version: 0, source: 'global', createdAt: null, note: null, chars: 22, active: false },
  ],
};

interface Call {
  url: string;
  method: string;
  authorization: string | null;
  contentType: string | null;
  body: unknown;
}

let calls: Call[];
let answer: () => Response;

beforeEach(() => {
  calls = [];
  answer = () => Response.json(DETAIL);
  vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
    const headers = new Headers(init.headers);
    calls.push({
      url,
      method: init.method ?? 'GET',
      authorization: headers.get('authorization'),
      contentType: headers.get('content-type'),
      body: typeof init.body === 'string' ? (JSON.parse(init.body) as unknown) : undefined,
    });
    return answer();
  });
});

afterEach(() => vi.unstubAllGlobals());

describe('promptEndpoints', () => {
  it('lists the prompts with a GET and the session token', async () => {
    answer = () => Response.json({ items: [] });
    await expect(promptEndpoints.list()).resolves.toEqual({ items: [] });
    expect(calls).toEqual([
      { url: '/api/v1/prompts', method: 'GET', authorization: 'Bearer session-token', contentType: null, body: undefined },
    ]);
  });

  it('reads a prompt by its dotted name', async () => {
    await expect(promptEndpoints.get('planner.system')).resolves.toEqual(DETAIL);
    expect(calls[0]).toMatchObject({ url: '/api/v1/prompts/planner.system', method: 'GET' });
  });

  it('reads one version, the global default included', async () => {
    answer = () => Response.json({ ...DETAIL.versions[2], text: 'Global {{shot.prompt}}' });
    await expect(promptEndpoints.getVersion('video.user', 0)).resolves.toMatchObject({ version: 0, source: 'global' });
    expect(calls[0]).toMatchObject({ url: '/api/v1/prompts/video.user/versions/0', method: 'GET' });
  });

  it('saves with a PUT and the text and note as the JSON body', async () => {
    const detail = await promptEndpoints.save('image.user', { text: 'Shot: {{shot.prompt}}', note: 'calmer' });
    expect(detail).toEqual(DETAIL);
    expect(calls).toEqual([
      {
        url: '/api/v1/prompts/image.user',
        method: 'PUT',
        authorization: 'Bearer session-token',
        contentType: 'application/json',
        body: { text: 'Shot: {{shot.prompt}}', note: 'calmer' },
      },
    ]);
  });

  it('activates with a POST of the version', async () => {
    await promptEndpoints.activate('image.user', { version: 0 });
    expect(calls[0]).toMatchObject({
      url: '/api/v1/prompts/image.user/activate',
      method: 'POST',
      body: { version: 0 },
    });
  });

  it('never repeats a save, even when the service answers 503', async () => {
    answer = () =>
      Response.json({ error: { code: 'internal', message: 'Down' } }, { status: 503, headers: { 'Retry-After': '1' } });
    const error: unknown = await promptEndpoints.save('image.user', { text: 'x' }).catch((err: unknown) => err);
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).code).toBe('service_unavailable');
    expect(calls).toHaveLength(1);
  });

  it('keeps the problems of a rejected prompt for the editor', async () => {
    const errors = ['Missing required placeholder {{shot.prompt}}.', 'Unknown placeholder {{nope}}.'];
    answer = () =>
      Response.json({ error: { code: 'validation_failed', message: errors[0], details: { errors } } }, { status: 400 });
    const error: unknown = await promptEndpoints.save('image.user', { text: 'x' }).catch((err: unknown) => err);
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).status).toBe(400);
    expect(validationErrors(error)).toEqual(errors);
  });

  it('rejects an answer that is not a prompt detail', async () => {
    answer = () => Response.json({ name: 'image.user' });
    const error: unknown = await promptEndpoints.get('image.user').catch((err: unknown) => err);
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).code).toBe('invalid_response');
  });
});

describe('prompt query keys', () => {
  it('keeps the list, every detail and every version apart under one prefix', () => {
    const { prompts } = queryKeys;
    expect(prompts.list).toEqual(['prompts', 'list']);
    expect(prompts.detail('image.user')).toEqual(['prompts', 'detail', 'image.user']);
    expect(prompts.version('image.user', 2)).toEqual(['prompts', 'version', 'image.user', 2]);
    for (const key of [prompts.list, prompts.detail('video.user'), prompts.version('video.user', 0)]) {
      expect(key[0]).toBe(prompts.all[0]);
    }
    expect(prompts.detail('image.user')).not.toEqual(prompts.detail('video.user'));
  });
});
