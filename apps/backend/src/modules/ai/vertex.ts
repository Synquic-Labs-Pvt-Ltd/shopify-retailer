import type { AiProvider, AiResult, ModelTarget, VideoPollResponse, VideoSubmitRequest } from './index';
import { classifyTransportError, makeAiError } from './errors';
import { createGeminiContentApi, type PreparedCall } from './gemini-core';
import { requestJson, type HttpContext } from './http';
import { asList, asString, fromBase64, isRecord, toBase64, type JsonRecord } from './json';
import { MAX_REFERENCE_IMAGES, parseSubmitResponse, raiFilteredError, readOperation, readRaiFilter } from './veo';

// Vertex AI REST adapter. Auth is an OAuth token for the cloud-platform scope; the URL depends on the
// per-model location, and "global" has its own host (SPEC 13, locations).

const LOCATION_PATTERN = /^[a-z0-9][a-z0-9-]*$/;
const MODEL_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const PROJECT_PATTERN = /^[a-z0-9][a-z0-9.:-]*$/;

const OPERATION_NAME = /^projects\/([^/]+)\/locations\/([^/]+)\/publishers\/google\/models\/([^/]+)\/operations\/[^/]+$/;

export function vertexHost(location: string): string {
  return location === 'global' ? 'aiplatform.googleapis.com' : `${location}-aiplatform.googleapis.com`;
}

export function vertexModelUrl(project: string, location: string, model: string, method: string): string {
  return `https://${vertexHost(location)}/v1/projects/${project}/locations/${location}/publishers/google/models/${model}:${method}`;
}

export interface VertexDeps {
  http: HttpContext;
  // GOOGLE_CLOUD_PROJECT. When missing, every call returns an auth_error result.
  project: string | undefined;
  // Returns a fresh-enough OAuth access token (the default implementation caches via google-auth-library).
  getAccessToken: () => Promise<string>;
}

const NETWORK_CODES = new Set(['ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'ENOTFOUND', 'EAI_AGAIN', 'ECONNABORTED']);

function classifyTokenError(err: unknown) {
  const code = isRecord(err) ? asString(err.code) : null;
  if (code !== null && NETWORK_CODES.has(code)) return classifyTransportError(err);
  const message = err instanceof Error ? err.message : String(err);
  return makeAiError('auth_error', `Could not obtain a Google access token: ${message}`, { providerReason: 'token_error' });
}

function buildSubmitBody(request: VideoSubmitRequest): JsonRecord {
  const referenceImages = request.referenceImages.slice(0, MAX_REFERENCE_IMAGES).map((image) => ({
    image: { bytesBase64Encoded: toBase64(image.data), mimeType: image.mimeType },
    referenceType: 'asset',
  }));
  return {
    instances: [{ prompt: request.prompt, ...(referenceImages.length > 0 ? { referenceImages } : {}) }],
    parameters: {
      aspectRatio: request.aspectRatio,
      durationSeconds: request.durationSeconds,
      resolution: request.resolution,
      generateAudio: request.generateAudio,
      personGeneration: request.personGeneration,
      sampleCount: request.sampleCount,
      ...(request.negativePrompt.length > 0 ? { negativePrompt: request.negativePrompt } : {}),
    },
  };
}

// Without a storageUri Veo returns the video inline as videos[].bytesBase64Encoded. A Cloud Storage URI
// means the request asked for storage output, which this adapter never does and does not read.
function readVertexVideo(response: JsonRecord): AiResult<VideoPollResponse> {
  const videos = asList(response.videos).filter(isRecord);
  const inline = videos.find((video) => typeof video.bytesBase64Encoded === 'string' && video.bytesBase64Encoded.length > 0);
  if (inline !== undefined && typeof inline.bytesBase64Encoded === 'string') {
    return {
      ok: true,
      value: {
        done: true,
        video: { bytes: fromBase64(inline.bytesBase64Encoded), mimeType: asString(inline.mimeType) ?? 'video/mp4' },
        modelVersion: null,
      },
    };
  }
  const filter = readRaiFilter(response);
  if (filter.count > 0) return { ok: false, error: raiFilteredError(filter) };
  const storageUri = videos.map((video) => asString(video.gcsUri)).find((uri) => uri !== null && uri !== undefined);
  if (storageUri !== undefined && storageUri !== null) {
    return {
      ok: false,
      error: makeAiError(
        'invalid_request',
        `Veo returned a Cloud Storage URI (${storageUri}) instead of inline video bytes. This adapter requests inline output (no storageUri) and does not read Cloud Storage.`,
        { providerReason: 'storage_uri_only' },
      ),
    };
  }
  return { ok: false, error: makeAiError('no_output', 'Veo operation finished without a video') };
}

export function createVertexProvider(deps: VertexDeps): AiProvider {
  const { http } = deps;

  const prepare = async (target: ModelTarget, method: string, projectOverride?: string): Promise<AiResult<PreparedCall>> => {
    const project = projectOverride ?? deps.project;
    if (project === undefined || !PROJECT_PATTERN.test(project)) {
      return {
        ok: false,
        error: makeAiError('auth_error', 'GOOGLE_CLOUD_PROJECT is not set or is not a valid project id', { providerReason: 'missing_project' }),
      };
    }
    if (!LOCATION_PATTERN.test(target.location) || !MODEL_PATTERN.test(target.model)) {
      return {
        ok: false,
        error: makeAiError('invalid_request', `Invalid Vertex location "${target.location}" or model "${target.model}"`),
      };
    }
    let token: string;
    try {
      token = await deps.getAccessToken();
    } catch (err) {
      return { ok: false, error: classifyTokenError(err) };
    }
    return {
      ok: true,
      value: {
        url: vertexModelUrl(project, target.location, target.model, method),
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      },
    };
  };

  const content = createGeminiContentApi(http, prepare, { sendSize: true, sendOutputOptions: true });

  return {
    name: 'vertex',
    plan: content.plan,
    generateImage: content.generateImage,

    async submitVideo(request) {
      const prepared = await prepare(request, 'predictLongRunning');
      if (!prepared.ok) return prepared;
      const response = await requestJson(http, {
        op: 'vertex.predictLongRunning',
        url: prepared.value.url,
        headers: prepared.value.headers,
        body: buildSubmitBody(request),
        signal: request.signal,
      });
      return response.ok ? parseSubmitResponse(response.value) : response;
    },

    async pollVideo(request) {
      // The operation name carries the project, location and model it was submitted to. Polling there keeps a
      // video in flight working when the config is edited (hot reload) between submit and poll.
      const origin = OPERATION_NAME.exec(request.operationName);
      const target: ModelTarget = origin === null ? request : { ...request, location: origin[2] ?? request.location, model: origin[3] ?? request.model };
      const prepared = await prepare(target, 'fetchPredictOperation', origin?.[1]);
      if (!prepared.ok) return prepared;
      const response = await requestJson(http, {
        op: 'vertex.fetchPredictOperation',
        url: prepared.value.url,
        headers: prepared.value.headers,
        body: { operationName: request.operationName },
        signal: request.signal,
      });
      if (!response.ok) return response;
      const operation = readOperation(response.value);
      if (operation.state === 'pending') return { ok: true, value: { done: false } };
      if (operation.state === 'failed') return { ok: false, error: operation.error };
      return readVertexVideo(operation.response);
    },
  };
}
