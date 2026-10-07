import { z } from 'zod';
import { createCreativePlanSchema, type PlanCounts } from '@rs/shared';
import { isRecord, type JsonRecord } from './json';

// The Gemini responseSchema is an OpenAPI-style subset of JSON Schema: upper-case type names and none of
// $schema, additionalProperties or string length limits. Length and word-count rules are not sent; the
// response is validated with the zod schema afterwards. Array bounds are kept because they pin the exact
// number of image and video shots.

export type GeminiSchema = JsonRecord;

const SCALAR_TYPES: Record<string, string> = {
  string: 'STRING',
  number: 'NUMBER',
  integer: 'INTEGER',
  boolean: 'BOOLEAN',
};

function reduceNode(node: unknown, path: string): GeminiSchema {
  if (!isRecord(node)) throw new Error(`Unsupported JSON Schema node at ${path}`);
  const type = node.type;

  if (type === 'object') {
    const properties = isRecord(node.properties) ? node.properties : {};
    const reduced: JsonRecord = {};
    for (const [key, child] of Object.entries(properties)) reduced[key] = reduceNode(child, `${path}.${key}`);
    const required = Array.isArray(node.required) ? node.required.filter((item) => typeof item === 'string') : [];
    return {
      type: 'OBJECT',
      properties: reduced,
      ...(required.length > 0 ? { required } : {}),
      propertyOrdering: Object.keys(properties),
    };
  }

  if (type === 'array') {
    const result: GeminiSchema = { type: 'ARRAY', items: reduceNode(node.items, `${path}[]`) };
    if (typeof node.minItems === 'number' && node.minItems > 0) result.minItems = node.minItems;
    if (typeof node.maxItems === 'number') result.maxItems = node.maxItems;
    return result;
  }

  if (typeof type === 'string' && type in SCALAR_TYPES) {
    const result: GeminiSchema = { type: SCALAR_TYPES[type] };
    if (Array.isArray(node.enum)) result.enum = node.enum;
    return result;
  }

  throw new Error(`Unsupported JSON Schema construct at ${path}`);
}

export function reduceToGeminiSchema(jsonSchema: unknown): GeminiSchema {
  return reduceNode(jsonSchema, '$');
}

// Response schema for the planner call, with the exact shot counts for this product.
export function buildPlanResponseSchema(counts: PlanCounts): GeminiSchema {
  return reduceToGeminiSchema(z.toJSONSchema(createCreativePlanSchema(counts), { io: 'output' }));
}
