import { PROMPT_DEFINITIONS, PROMPT_MAX_CHARS, validatePromptText, type PromptVersionInfo } from '@rs/shared';
import { describe, expect, it } from 'vitest';
import {
  activeVersionBadge,
  canSavePrompt,
  charCountText,
  insertPlaceholder,
  isDirty,
  knownVersionText,
  lastEditedText,
  latestVersionText,
  mergeErrors,
  noteText,
  orderedVersions,
  placeholderStatuses,
  promptBadge,
  savedAtText,
  sizeText,
  versionActionLabel,
  versionLabel,
} from './logic';

const NOW = Date.parse('2026-03-20T12:00:00.000Z');

const info = (version: number, overrides: Partial<PromptVersionInfo> = {}): PromptVersionInfo => ({
  version,
  source: version === 0 ? 'global' : 'store',
  createdAt: version === 0 ? null : '2026-03-20T11:00:00.000Z',
  note: null,
  chars: 100,
  active: false,
  ...overrides,
});

describe('labels', () => {
  it('names the version', () => {
    expect(versionLabel(0)).toBe('v0');
    expect(versionLabel(12)).toBe('v12');
  });

  it('badges a prompt in the list as the global default or custom with its version', () => {
    expect(promptBadge(0)).toEqual({ tone: 'neutral', label: 'Global default' });
    expect(promptBadge(3)).toEqual({ tone: 'info', label: 'Custom · v3' });
  });

  it('shows the active version in the editor status line', () => {
    expect(activeVersionBadge(0)).toEqual({ tone: 'neutral', label: 'Global default (v0)' });
    expect(activeVersionBadge(2)).toEqual({ tone: 'info', label: 'Custom v2' });
  });

  it('says which version is the latest', () => {
    expect(latestVersionText(0)).toBe('No custom versions yet');
    expect(latestVersionText(4)).toBe('v4 is the latest');
  });

  it('labels the action of a version row', () => {
    expect(versionActionLabel(0)).toBe('Use global default');
    expect(versionActionLabel(5)).toBe('Make active');
  });
});

describe('lastEditedText', () => {
  it('is null for the global default and for a date it cannot read', () => {
    expect(lastEditedText(null, NOW)).toBeNull();
    expect(lastEditedText('not a date', NOW)).toBeNull();
  });

  it('is relative for a recent save', () => {
    expect(lastEditedText('2026-03-20T11:55:00.000Z', NOW)).toBe('Last edited 5 min ago');
    expect(lastEditedText('2026-03-19T11:00:00.000Z', NOW)).toBe('Last edited yesterday');
    expect(lastEditedText('2026-03-10T12:00:00.000Z', NOW)).toBe('Last edited 10 days ago');
  });

  it('is a calendar date once the save is two weeks old', () => {
    const text = lastEditedText('2026-01-05T12:00:00.000Z', NOW);
    expect(text).toMatch(/^Last edited /);
    expect(text).not.toMatch(/ago$/);
    expect(text).toContain('2026');
  });
});

describe('version table', () => {
  it('shows a dash instead of a date for the global default', () => {
    expect(savedAtText(null)).toBe('—');
    expect(savedAtText('garbage')).toBe('—');
    expect(savedAtText('2026-03-20T11:00:00.000Z')).not.toBe('—');
  });

  it('shows the note, a dash when there is none, and a name for the global default', () => {
    expect(noteText(info(2, { note: 'warmer light' }))).toBe('warmer light');
    expect(noteText(info(2, { note: null }))).toBe('—');
    expect(noteText(info(2, { note: '   ' }))).toBe('—');
    expect(noteText(info(0))).toBe('Global default');
  });

  it('groups the digits of the size', () => {
    expect(sizeText(950)).toBe('950');
    expect(sizeText(12_345)).toBe('12,345');
  });

  it('puts the newest version first and the global default last, whatever the server order', () => {
    const versions = [info(0), info(1), info(3), info(2)];
    expect(orderedVersions(versions).map((version) => version.version)).toEqual([3, 2, 1, 0]);
    expect(versions.map((version) => version.version)).toEqual([0, 1, 3, 2]);
    expect(orderedVersions([info(1), info(0)]).map((version) => version.version)).toEqual([1, 0]);
  });
});

describe('dirty and save', () => {
  it('does not count line endings or trailing white space as a change', () => {
    expect(isDirty('Hello\nworld', 'Hello\nworld')).toBe(false);
    expect(isDirty('Hello\r\nworld\r\n\r\n', 'Hello\nworld')).toBe(false);
    expect(isDirty('Hello world', 'Hello\nworld')).toBe(true);
    expect(isDirty('', 'Hello')).toBe(true);
  });

  it('saves only a changed, valid text while nothing else is running', () => {
    expect(canSavePrompt({ dirty: true, valid: true, busy: false })).toBe(true);
    expect(canSavePrompt({ dirty: false, valid: true, busy: false })).toBe(false);
    expect(canSavePrompt({ dirty: true, valid: false, busy: false })).toBe(false);
    expect(canSavePrompt({ dirty: true, valid: true, busy: true })).toBe(false);
  });

  it('counts the characters the server counts', () => {
    expect(charCountText('abc\r\n\r\n')).toBe(`3 of ${PROMPT_MAX_CHARS.toLocaleString('en-US')} characters`);
  });

  it('merges the live problems with the ones only the server found, without repeats', () => {
    expect(mergeErrors(['a', 'b'], ['b', 'c'])).toEqual(['a', 'b', 'c']);
    expect(mergeErrors([], [])).toEqual([]);
  });
});

describe('knownVersionText', () => {
  const detail = { activeVersion: 2, text: 'active text', globalText: 'global text' };

  it('knows the global default and the active version without a request', () => {
    expect(knownVersionText(detail, 0)).toBe('global text');
    expect(knownVersionText(detail, 2)).toBe('active text');
  });

  it('needs a request for any other version', () => {
    expect(knownVersionText(detail, 1)).toBeNull();
    expect(knownVersionText({ ...detail, activeVersion: 0 }, 0)).toBe('global text');
  });
});

describe('placeholders', () => {
  const planner = PROMPT_DEFINITIONS['planner.system'];

  it('lists every placeholder of the prompt with Required and the use of it', () => {
    const statuses = placeholderStatuses('planner.system', 'Plan {{imageCount}} and {{videoDurationSeconds}}.');
    expect(statuses.map((status) => status.name).sort()).toEqual(planner.placeholders.map((p) => p.name).sort());
    const byName = Object.fromEntries(statuses.map((status) => [status.name, status]));
    expect(byName.imageCount).toMatchObject({ required: true, present: true, token: '{{imageCount}}' });
    expect(byName.videoCount).toMatchObject({ required: true, present: false });
    expect(byName.videoDurationSeconds).toMatchObject({ required: false, present: true });
    expect(byName.videoAspectRatio).toMatchObject({ required: false, present: false });
  });

  it('puts the required placeholders first', () => {
    const statuses = placeholderStatuses('image.user', '');
    const firstOptional = statuses.findIndex((status) => !status.required);
    expect(statuses.slice(0, firstOptional).every((status) => status.required)).toBe(true);
    expect(statuses.slice(firstOptional).every((status) => !status.required)).toBe(true);
  });

  it('reads placeholders with white space inside the braces the way the renderer does', () => {
    const statuses = placeholderStatuses('video.user', '{{ shot.prompt }} {{plan.product.mustPreserve}}');
    expect(statuses.filter((status) => status.required).every((status) => status.present)).toBe(true);
  });

  it('agrees with the validation: every required placeholder present means no missing-placeholder error', () => {
    const text = '{{shot.prompt}} then {{plan.product.mustPreserve}}';
    expect(placeholderStatuses('video.user', text).filter((status) => status.required && !status.present)).toEqual([]);
    expect(validatePromptText('video.user', text).ok).toBe(true);
    const missing = validatePromptText('video.user', '{{shot.prompt}}');
    expect(missing.ok).toBe(false);
    expect(placeholderStatuses('video.user', '{{shot.prompt}}').find((status) => status.name === 'plan.product.mustPreserve')?.present).toBe(false);
  });
});

describe('insertPlaceholder', () => {
  it('puts the token at the end of an empty text as it is', () => {
    expect(insertPlaceholder('', 'shot.prompt')).toBe('{{shot.prompt}}');
  });

  it('separates it from a word with a space and leaves existing white space alone', () => {
    expect(insertPlaceholder('Shot:', 'shot.prompt')).toBe('Shot: {{shot.prompt}}');
    expect(insertPlaceholder('Shot: ', 'shot.prompt')).toBe('Shot: {{shot.prompt}}');
    expect(insertPlaceholder('Shot:\n', 'shot.prompt')).toBe('Shot:\n{{shot.prompt}}');
  });

  it('makes a placeholder the live check then counts as used', () => {
    const text = insertPlaceholder('Camera: ', 'shot.camera');
    expect(placeholderStatuses('image.user', text).find((status) => status.name === 'shot.camera')?.present).toBe(true);
  });
});
