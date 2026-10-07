import type {
  AiErrorKind,
  AiProviderName,
  ImageOutputMimeType,
  ImageSize,
  PersonGenerationMode,
  VideoAspectRatio,
  VideoResolution,
} from '@rs/shared';

// Providers never throw for API failures. They return an AiResult with the error classified
// from the raw response body (status, error.status, ErrorInfo, QuotaFailure, RetryInfo).
export interface ClassifiedError {
  kind: AiErrorKind;
  message: string;
  httpStatus: number | null;
  providerStatus: string | null;
  providerReason: string | null;
  retryDelayMs: number | null;
  rawBody: string | null;
  retryable: boolean;
}

export type AiResult<T> = { ok: true; value: T } | { ok: false; error: ClassifiedError };

export type AiPart =
  | { kind: 'text'; text: string }
  | { kind: 'inlineData'; mimeType: string; data: Uint8Array }
  | { kind: 'fileData'; mimeType: string; uri: string };

export interface ModelTarget {
  model: string;
  // Vertex location; ignored by aistudio and fake.
  location: string;
  signal: AbortSignal;
}

export interface PlanRequest extends ModelTarget {
  systemPrompt: string;
  parts: AiPart[];
  imageCount: number;
  videoCount: number;
  temperature: number;
}

export interface PlanResponse {
  // Parsed JSON from the model. The caller validates it with the creative plan schema.
  json: unknown;
  rawText: string;
  responseId: string | null;
  modelVersion: string | null;
}

export interface ImageRequest extends ModelTarget {
  parts: AiPart[];
  aspectRatio: string;
  imageSize: ImageSize;
  outputMimeType: ImageOutputMimeType;
}

export interface ImageResponse {
  bytes: Uint8Array;
  mimeType: string;
  responseId: string | null;
  modelVersion: string | null;
}

export interface VideoSubmitRequest extends ModelTarget {
  prompt: string;
  negativePrompt: string;
  referenceImages: { mimeType: string; data: Uint8Array }[];
  durationSeconds: number;
  aspectRatio: VideoAspectRatio;
  resolution: VideoResolution;
  generateAudio: boolean;
  personGeneration: PersonGenerationMode;
  sampleCount: number;
}

export interface VideoOperation {
  operationName: string;
}

export interface VideoPollRequest extends ModelTarget {
  operationName: string;
}

export type VideoPollResponse =
  | { done: false }
  | { done: true; video: { bytes: Uint8Array; mimeType: string }; modelVersion: string | null };

export interface AiProvider {
  readonly name: AiProviderName;
  plan(request: PlanRequest): Promise<AiResult<PlanResponse>>;
  generateImage(request: ImageRequest): Promise<AiResult<ImageResponse>>;
  submitVideo(request: VideoSubmitRequest): Promise<AiResult<VideoOperation>>;
  pollVideo(request: VideoPollRequest): Promise<AiResult<VideoPollResponse>>;
}

export interface AiService {
  getProvider(name: AiProviderName): AiProvider;
  // Plain {{placeholder}} substitution; product data is inserted as text, never as instructions.
  renderPrompt(template: string, values: Record<string, string>): string;
}
