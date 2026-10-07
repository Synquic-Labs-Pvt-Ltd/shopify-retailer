import type { AiResult, ClassifiedError, VideoOperation } from './index';
import { classifyOperationError, makeAiError } from './errors';
import { asList, asString, isRecord, type JsonRecord } from './json';

// Veo response handling shared by the Vertex and AI Studio adapters.

// Reference-image mode takes at most three asset images.
export const MAX_REFERENCE_IMAGES = 3;

export function parseSubmitResponse(json: unknown): AiResult<VideoOperation> {
  const name = isRecord(json) ? asString(json.name) : null;
  if (name === null || name.length === 0) {
    return {
      ok: false,
      error: makeAiError('no_output', 'Video submit response had no operation name', { rawBody: JSON.stringify(json) }),
    };
  }
  return { ok: true, value: { operationName: name } };
}

export type OperationState =
  | { state: 'pending' }
  | { state: 'failed'; error: ClassifiedError }
  | { state: 'done'; response: JsonRecord };

export function readOperation(json: unknown): OperationState {
  if (!isRecord(json)) {
    return { state: 'failed', error: makeAiError('transient', 'Operation response is not a JSON object') };
  }
  if (json.error !== undefined && json.error !== null) {
    return { state: 'failed', error: classifyOperationError(json.error) };
  }
  if (json.done !== true) return { state: 'pending' };
  return { state: 'done', response: isRecord(json.response) ? json.response : {} };
}

export interface RaiFilter {
  count: number;
  reasons: string[];
}

export function readRaiFilter(response: JsonRecord): RaiFilter {
  const count = typeof response.raiMediaFilteredCount === 'number' ? response.raiMediaFilteredCount : 0;
  const reasons = asList(response.raiMediaFilteredReasons).filter((reason) => typeof reason === 'string');
  return { count, reasons };
}

export function raiFilteredError(filter: RaiFilter): ClassifiedError {
  const reasons = filter.reasons.length > 0 ? `: ${filter.reasons.join('; ')}` : '';
  return makeAiError('safety_blocked', `Video blocked by the provider's safety filters${reasons}`, {
    providerReason: 'rai_media_filtered',
    rawBody: JSON.stringify({ raiMediaFilteredCount: filter.count, raiMediaFilteredReasons: filter.reasons }),
  });
}
