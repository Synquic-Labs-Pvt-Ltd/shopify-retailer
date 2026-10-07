import { describe, expect, it } from 'vitest';
import { createCreativePlanSchema, creativePlanSchema } from '@rs/shared';
import { buildFakePlan } from '../../src/modules/ai/fake';
import { parseImageResponse, parsePlanResponse } from '../../src/modules/ai/gemini-content';
import { buildPlanResponseSchema, reduceToGeminiSchema } from '../../src/modules/ai/schema';
import { b64, bytes, fixtureJson } from './helpers';

function imageBody(parts: unknown[], extra: Record<string, unknown> = {}): unknown {
  return { candidates: [{ content: { role: 'model', parts }, finishReason: 'STOP' }], responseId: 'resp-1', modelVersion: 'm-1', ...extra };
}

describe('parseImageResponse', () => {
  it('returns the first inline image part of the first candidate', () => {
    const png = bytes(1, 2, 3);
    const result = parseImageResponse(
      imageBody([{ text: 'Here you go' }, { inlineData: { mimeType: 'image/jpeg', data: b64(png) } }, { inlineData: { mimeType: 'image/png', data: b64(bytes(9)) } }]),
    );
    expect(result).toMatchObject({ ok: true, value: { mimeType: 'image/jpeg', responseId: 'resp-1', modelVersion: 'm-1' } });
    if (result.ok) expect([...result.value.bytes]).toEqual([1, 2, 3]);
  });

  it('skips interim thought images', () => {
    const result = parseImageResponse(
      imageBody([
        { thought: true, inlineData: { mimeType: 'image/png', data: b64(bytes(7)) } },
        { inlineData: { mimeType: 'image/png', data: b64(bytes(8)) } },
      ]),
    );
    expect(result.ok && [...result.value.bytes]).toEqual([8]);
  });

  it('ignores non-image inline data', () => {
    const result = parseImageResponse(imageBody([{ inlineData: { mimeType: 'audio/wav', data: b64(bytes(1)) } }]));
    expect(result).toMatchObject({ ok: false, error: { kind: 'no_output' } });
  });

  const safetyCases: [string, string, string][] = [
    ['200-prompt-blocked.json', 'safety_blocked', 'PROHIBITED_CONTENT'],
    ['200-image-safety.json', 'safety_blocked', 'IMAGE_SAFETY'],
    ['200-finish-prohibited-content.json', 'safety_blocked', 'PROHIBITED_CONTENT'],
    ['200-finish-safety-with-text.json', 'safety_blocked', 'SAFETY'],
    ['200-no-image-text-only.json', 'no_output', 'STOP'],
    ['200-no-image-no-image-reason.json', 'no_output', 'NO_IMAGE'],
  ];

  it.each(safetyCases)('%s is classified %s', (fixture, kind, reason) => {
    const result = parseImageResponse(fixtureJson(fixture));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe(kind);
      expect(result.error.providerReason).toBe(reason);
      expect(result.error.retryable).toBe(kind === 'no_output');
    }
  });

  it('treats an empty or malformed body as no_output', () => {
    expect(parseImageResponse({})).toMatchObject({ ok: false, error: { kind: 'no_output' } });
    expect(parseImageResponse({ candidates: 'nope' })).toMatchObject({ ok: false, error: { kind: 'no_output' } });
    expect(parseImageResponse(null)).toMatchObject({ ok: false, error: { kind: 'no_output' } });
  });
});

describe('parsePlanResponse', () => {
  const plan = buildFakePlan({ imageCount: 2, videoCount: 1 });

  it('parses the JSON text of the first candidate', () => {
    const result = parsePlanResponse(imageBody([{ text: JSON.stringify(plan) }]));
    expect(result).toMatchObject({ ok: true, value: { json: plan, responseId: 'resp-1', modelVersion: 'm-1' } });
  });

  it('joins split text parts and strips code fences', () => {
    const text = JSON.stringify(plan);
    const split = parsePlanResponse(imageBody([{ text: text.slice(0, 40) }, { text: text.slice(40) }]));
    expect(split.ok && split.value.json).toEqual(plan);
    const fenced = parsePlanResponse(imageBody([{ text: `\`\`\`json\n${text}\n\`\`\`` }]));
    expect(fenced.ok && fenced.value.json).toEqual(plan);
  });

  it('ignores thought text parts', () => {
    const result = parsePlanResponse(imageBody([{ thought: true, text: 'thinking...' }, { text: '{"a":1}' }]));
    expect(result.ok && result.value.json).toEqual({ a: 1 });
  });

  it('returns no_output for truncated or non-JSON text', () => {
    const result = parsePlanResponse({ candidates: [{ content: { parts: [{ text: '{"product": {"category": "lam' }] }, finishReason: 'MAX_TOKENS' }] });
    expect(result).toMatchObject({ ok: false, error: { kind: 'no_output', providerReason: 'MAX_TOKENS', retryable: true } });
  });

  it('classifies blocked prompts and safety finish reasons', () => {
    expect(parsePlanResponse(fixtureJson('200-prompt-blocked.json'))).toMatchObject({ ok: false, error: { kind: 'safety_blocked' } });
    expect(parsePlanResponse(fixtureJson('200-finish-safety-with-text.json'))).toMatchObject({ ok: false, error: { kind: 'safety_blocked' } });
  });
});

describe('plan response schema', () => {
  function collect(node: unknown, found: Set<string> = new Set()): Set<string> {
    if (Array.isArray(node)) node.forEach((item) => collect(item, found));
    else if (typeof node === 'object' && node !== null) {
      for (const [key, value] of Object.entries(node)) {
        found.add(key);
        collect(value, found);
      }
    }
    return found;
  }

  it('uses the Gemini schema subset only', () => {
    const keys = collect(buildPlanResponseSchema({ imageCount: 2, videoCount: 1 }));
    for (const forbidden of ['$schema', 'additionalProperties', 'minLength', 'maxLength', '$ref', 'anyOf', 'pattern']) {
      expect(keys.has(forbidden)).toBe(false);
    }
  });

  it('is an upper-case OBJECT with the plan fields in order', () => {
    const schema = buildPlanResponseSchema({ imageCount: 2, videoCount: 1 });
    expect(schema.type).toBe('OBJECT');
    expect(schema.propertyOrdering).toEqual(['product', 'referenceStyle', 'imageShots', 'videoShots', 'warnings']);
    expect(schema.required).toEqual(['product', 'referenceStyle', 'imageShots', 'videoShots', 'warnings']);
    const props = schema.properties as Record<string, Record<string, unknown>>;
    expect(props.product?.type).toBe('OBJECT');
    expect(props.warnings).toEqual({ type: 'ARRAY', items: { type: 'STRING' } });
  });

  it('pins the exact shot counts with minItems and maxItems', () => {
    const props = buildPlanResponseSchema({ imageCount: 3, videoCount: 2 }).properties as Record<string, Record<string, unknown>>;
    expect(props.imageShots).toMatchObject({ type: 'ARRAY', minItems: 3, maxItems: 3 });
    expect(props.videoShots).toMatchObject({ type: 'ARRAY', minItems: 2, maxItems: 2 });
    const zeroVideo = buildPlanResponseSchema({ imageCount: 2, videoCount: 0 }).properties as Record<string, Record<string, unknown>>;
    expect(zeroVideo.videoShots).toMatchObject({ type: 'ARRAY', maxItems: 0 });
  });

  it('declares every field of the video shot, including cameraMove and subjectAction', () => {
    const props = buildPlanResponseSchema({ imageCount: 1, videoCount: 1 }).properties as Record<string, { items?: { properties?: Record<string, unknown> } }>;
    expect(Object.keys(props.imageShots?.items?.properties ?? {})).toEqual(['shotId', 'title', 'scene', 'camera', 'lighting', 'people', 'prompt', 'negative']);
    expect(Object.keys(props.videoShots?.items?.properties ?? {})).toEqual([
      'shotId', 'title', 'scene', 'camera', 'lighting', 'people', 'prompt', 'negative', 'cameraMove', 'subjectAction',
    ]);
  });

  it('describes the same fields the zod plan schema accepts', () => {
    const schemaKeys = Object.keys(buildPlanResponseSchema({ imageCount: 1, videoCount: 1 }).properties as object);
    const shape = Object.keys(creativePlanSchema.shape);
    expect(schemaKeys).toEqual(shape);
    expect(createCreativePlanSchema({ imageCount: 1, videoCount: 1 }).safeParse(buildFakePlan({ imageCount: 1, videoCount: 1 })).success).toBe(true);
  });

  it('rejects JSON Schema constructs it cannot express', () => {
    expect(() => reduceToGeminiSchema({ anyOf: [{ type: 'string' }, { type: 'number' }] })).toThrow(/Unsupported/);
    expect(() => reduceToGeminiSchema(null)).toThrow(/Unsupported/);
  });
});
