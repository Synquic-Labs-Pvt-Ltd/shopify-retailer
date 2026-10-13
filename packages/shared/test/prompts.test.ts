import { describe, expect, it } from 'vitest';
import {
  PROMPT_DEFINITIONS,
  PROMPT_MAX_CHARS,
  PROMPT_NAMES,
  isPromptName,
  normalizePromptText,
  usedPlaceholders,
  validatePromptText,
} from '../src';

describe('prompt definitions', () => {
  it('describe the three prompts and mark the placeholders the pipeline needs', () => {
    expect(PROMPT_NAMES).toEqual(['planner.system', 'image.user', 'video.user']);
    for (const name of PROMPT_NAMES) {
      const definition = PROMPT_DEFINITIONS[name];
      expect(definition.name).toBe(name);
      expect(definition.placeholders.some((placeholder) => placeholder.required)).toBe(true);
    }
    expect(PROMPT_DEFINITIONS['planner.system'].placeholders.filter((p) => p.required).map((p) => p.name)).toEqual([
      'imageCount',
      'videoCount',
      'styleGuidance',
    ]);
  });

  it('recognises prompt names', () => {
    expect(isPromptName('image.user')).toBe(true);
    expect(isPromptName('image')).toBe(false);
  });
});

describe('normalizePromptText', () => {
  it('strips a BOM, unifies line endings and trims the end', () => {
    expect(normalizePromptText('﻿line one\r\nline two  \r\n\r\n')).toBe('line one\nline two');
  });
});

describe('usedPlaceholders', () => {
  it('lists each placeholder once, with or without inner spaces', () => {
    expect(usedPlaceholders('a {{shot.prompt}} b {{ shot.prompt }} c {{image.aspectRatio}}')).toEqual(['shot.prompt', 'image.aspectRatio']);
  });
});

describe('validatePromptText', () => {
  const goodImage = 'Shoot {{shot.prompt}} and keep {{plan.product.mustPreserve}}.';

  it('accepts a template with the required placeholders and returns it normalized', () => {
    expect(validatePromptText('image.user', `${goodImage}\r\n`)).toEqual({ ok: true, text: goodImage });
  });

  it('rejects an unknown placeholder and lists the allowed ones', () => {
    const result = validatePromptText('image.user', `${goodImage} {{brand}}`);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors[0]).toContain('Unknown placeholder {{brand}}');
      expect(result.errors[0]).toContain('{{shot.prompt}}');
    }
  });

  it('rejects a missing required placeholder', () => {
    const result = validatePromptText('video.user', 'Just a video.');
    expect(result).toMatchObject({ ok: false });
    if (!result.ok) expect(result.errors).toEqual(['Missing required placeholder {{shot.prompt}}.', 'Missing required placeholder {{plan.product.mustPreserve}}.']);
  });

  it('rejects a malformed placeholder', () => {
    const result = validatePromptText('image.user', `${goodImage} {{ shot prompt }}`);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.join(' ')).toContain('malformed');
  });

  it('rejects an empty or an oversized prompt', () => {
    expect(validatePromptText('image.user', '  \n ')).toEqual({ ok: false, errors: ['The prompt cannot be empty.'] });
    const big = validatePromptText('image.user', `${goodImage}${'x'.repeat(PROMPT_MAX_CHARS)}`);
    expect(big.ok).toBe(false);
    if (!big.ok) expect(big.errors[0]).toContain('too long');
  });
});
