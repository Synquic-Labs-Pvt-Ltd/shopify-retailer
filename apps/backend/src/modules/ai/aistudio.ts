import type { AiProvider, AiResult, ModelTarget, VideoPollResponse, VideoSubmitRequest } from './index';
import { makeAiError } from './errors';
import { createGeminiContentApi, type PreparedCall } from './gemini-core';
import { requestBytes, requestJson, type HttpContext } from './http';
import { asList, asString, fromBase64, isRecord, toBase64, type JsonRecord } from './json';
import { MAX_REFERENCE_IMAGES, parseSubmitResponse, raiFilteredError, readOperation, readRaiFilter, validateVideoInputs } from './veo';

// Google AI Studio (Gemini API) REST adapter. Auth is the x-goog-api-key header.

export const AI_STUDIO_BASE_URL = 'https://generativelanguage.googleapis.com/v1beta';

const MODEL_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const OPERATION_PATTERN = /^[A-Za-z0-9][A-Za-z0-9/_.-]*$/;

export interface AiStudioDeps {
  http: HttpContext;
  // GEMINI_API_KEY. When missing, every call returns an auth_error result.
  apiKey: string | undefined;
}

// Veo on the Gemini API: audio is always on and generateAudio is rejected, so it is not sent. Only one
// video per request is possible, so sampleCount is not sent either. Image objects use bytesBase64Encoded
// plus mimeType, the form google-genai sends for this endpoint. The Veo REST reference also shows an
// inlineData form; if a deployment ever rejects this one, that is the alternative.
// Reference mode sends referenceImages of type asset; image-to-video sends the start image as
// instances[0].image (the first frame) and no referenceImages.
function buildInstance(request: VideoSubmitRequest): JsonRecord {
  if (request.startImage !== undefined) {
    return {
      prompt: request.prompt,
      image: { bytesBase64Encoded: toBase64(request.startImage.data), mimeType: request.startImage.mimeType },
    };
  }
  const referenceImages = request.referenceImages.slice(0, MAX_REFERENCE_IMAGES).map((image) => ({
    image: { bytesBase64Encoded: toBase64(image.data), mimeType: image.mimeType },
    referenceType: 'asset',
  }));
  return { prompt: request.prompt, ...(referenceImages.length > 0 ? { referenceImages } : {}) };
}

function buildSubmitBody(request: VideoSubmitRequest): JsonRecord {
  return {
    instances: [buildInstance(request)],
    parameters: {
      aspectRatio: request.aspectRatio,
      durationSeconds: request.durationSeconds,
      resolution: request.resolution,
      personGeneration: request.personGeneration,
      ...(request.negativePrompt.length > 0 ? { negativePrompt: request.negativePrompt } : {}),
    },
  };
}

function isGoogleHost(uri: string): boolean {
  try {
    const url = new URL(uri);
    return url.protocol === 'https:' && (url.hostname.endsWith('.googleapis.com') || url.hostname.endsWith('.googleusercontent.com'));
  } catch {
    return false;
  }
}

export function createAiStudioProvider(deps: AiStudioDeps): AiProvider {
  const { http } = deps;

  const keyHeaders = (apiKey: string): Record<string, string> => ({ 'content-type': 'application/json', 'x-goog-api-key': apiKey });

  const requireKey = (): AiResult<string> =>
    deps.apiKey === undefined
      ? { ok: false, error: makeAiError('auth_error', 'GEMINI_API_KEY is not set', { providerReason: 'missing_api_key' }) }
      : { ok: true, value: deps.apiKey };

  const prepare = async (target: ModelTarget, method: string): Promise<AiResult<PreparedCall>> => {
    const key = requireKey();
    if (!key.ok) return key;
    if (!MODEL_PATTERN.test(target.model)) {
      return { ok: false, error: makeAiError('invalid_request', `Invalid model "${target.model}"`) };
    }
    return { ok: true, value: { url: `${AI_STUDIO_BASE_URL}/models/${target.model}:${method}`, headers: keyHeaders(key.value) } };
  };

  // Generated videos are kept for 2 days only, so the file is downloaded as soon as the operation is done.
  // The API key is only sent to Google hosts.
  const downloadVideo = async (uri: string, apiKey: string, signal: AbortSignal): Promise<AiResult<VideoPollResponse>> => {
    const headers: Record<string, string> = isGoogleHost(uri) ? { 'x-goog-api-key': apiKey } : {};
    const file = await requestBytes(http, { op: 'aistudio.downloadVideo', url: uri, headers, signal });
    if (!file.ok) return file;
    const mimeType = file.value.contentType?.startsWith('video/') === true ? file.value.contentType : 'video/mp4';
    return { ok: true, value: { done: true, video: { bytes: file.value.bytes, mimeType }, modelVersion: null } };
  };

  const content = createGeminiContentApi(http, prepare, { sendSize: true, sendOutputOptions: false });

  return {
    name: 'aistudio',
    plan: content.plan,
    generateImage: content.generateImage,

    async submitVideo(request) {
      const conflict = validateVideoInputs(request);
      if (conflict !== null) return { ok: false, error: conflict };
      const prepared = await prepare(request, 'predictLongRunning');
      if (!prepared.ok) return prepared;
      const response = await requestJson(http, {
        op: 'aistudio.predictLongRunning',
        url: prepared.value.url,
        headers: prepared.value.headers,
        body: buildSubmitBody(request),
        signal: request.signal,
      });
      return response.ok ? parseSubmitResponse(response.value) : response;
    },

    async pollVideo(request) {
      const key = requireKey();
      if (!key.ok) return key;
      if (!OPERATION_PATTERN.test(request.operationName)) {
        return { ok: false, error: makeAiError('invalid_request', `Invalid operation name "${request.operationName}"`) };
      }
      const response = await requestJson(http, {
        op: 'aistudio.getOperation',
        url: `${AI_STUDIO_BASE_URL}/${request.operationName}`,
        method: 'GET',
        headers: { 'x-goog-api-key': key.value },
        signal: request.signal,
      });
      if (!response.ok) return response;
      const operation = readOperation(response.value);
      if (operation.state === 'pending') return { ok: true, value: { done: false } };
      if (operation.state === 'failed') return { ok: false, error: operation.error };

      const result = isRecord(operation.response.generateVideoResponse) ? operation.response.generateVideoResponse : operation.response;
      const sample = asList(result.generatedSamples).filter(isRecord).map((item) => item.video).find(isRecord);
      const uri = sample === undefined ? null : asString(sample.uri);
      if (uri !== null) return downloadVideo(uri, key.value, request.signal);
      const encoded = sample === undefined ? null : asString(sample.encodedVideo);
      if (encoded !== null && encoded.length > 0) {
        return { ok: true, value: { done: true, video: { bytes: fromBase64(encoded), mimeType: 'video/mp4' }, modelVersion: null } };
      }
      const filter = readRaiFilter(result);
      if (filter.count > 0) return { ok: false, error: raiFilteredError(filter) };
      return { ok: false, error: makeAiError('no_output', 'Veo operation finished without a video') };
    },
  };
}
