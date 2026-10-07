import { z } from 'zod';
import type { AiPart, AiResult, ClassifiedError, ImageRequest, ImageResponse, PlanRequest, PlanResponse } from './index';
import { makeAiError } from './errors';
import { fromBase64, parseJson, toBase64, type JsonRecord } from './json';
import { buildPlanResponseSchema } from './schema';

// generateContent request builders and response parsers shared by the Vertex and AI Studio adapters.
// Both endpoints speak the same JSON; only the URL, the auth header and a few image options differ.

export function toRestPart(part: AiPart): JsonRecord {
  switch (part.kind) {
    case 'text':
      return { text: part.text };
    case 'inlineData':
      return { inlineData: { mimeType: part.mimeType, data: toBase64(part.data) } };
    case 'fileData':
      return { fileData: { mimeType: part.mimeType, fileUri: part.uri } };
  }
}

export function buildPlanBody(request: PlanRequest): JsonRecord {
  return {
    systemInstruction: { parts: [{ text: request.systemPrompt }] },
    contents: [{ role: 'user', parts: request.parts.map(toRestPart) }],
    generationConfig: {
      temperature: request.temperature,
      responseMimeType: 'application/json',
      responseSchema: buildPlanResponseSchema({ imageCount: request.imageCount, videoCount: request.videoCount }),
    },
  };
}

// Optional image fields. A model that rejects them is retried without them (see gemini-core.ts).
export interface ImageOptions {
  sendSize: boolean;
  // Vertex only: imageOutputOptions. AI Studio has no JPEG option, so it returns what the model produces.
  sendOutputOptions: boolean;
}

export const JPEG_QUALITY = 90;

export function buildImageBody(request: ImageRequest, options: ImageOptions): JsonRecord {
  const imageConfig: JsonRecord = { aspectRatio: request.aspectRatio };
  if (options.sendSize) imageConfig.imageSize = request.imageSize;
  if (options.sendOutputOptions) {
    imageConfig.imageOutputOptions =
      request.outputMimeType === 'image/jpeg'
        ? { mimeType: request.outputMimeType, compressionQuality: JPEG_QUALITY }
        : { mimeType: request.outputMimeType };
  }
  return {
    contents: [{ role: 'user', parts: request.parts.map(toRestPart) }],
    generationConfig: { responseModalities: ['IMAGE', 'TEXT'], imageConfig },
  };
}

const partSchema = z.looseObject({
  text: z.string().nullish(),
  thought: z.boolean().nullish(),
  inlineData: z.looseObject({ mimeType: z.string().nullish(), data: z.string().nullish() }).nullish(),
});

const generateContentSchema = z.looseObject({
  candidates: z
    .array(
      z.looseObject({
        content: z.looseObject({ parts: z.array(partSchema).nullish() }).nullish(),
        finishReason: z.string().nullish(),
        finishMessage: z.string().nullish(),
      }),
    )
    .nullish(),
  promptFeedback: z.looseObject({ blockReason: z.string().nullish(), blockReasonMessage: z.string().nullish() }).nullish(),
  responseId: z.string().nullish(),
  modelVersion: z.string().nullish(),
});

type Part = z.infer<typeof partSchema>;

interface ParsedContent {
  parts: Part[];
  finishReason: string | null;
  finishMessage: string | null;
  blockReason: string | null;
  responseId: string | null;
  modelVersion: string | null;
}

function parseGenerateContent(json: unknown): AiResult<ParsedContent> {
  const parsed = generateContentSchema.safeParse(json);
  if (!parsed.success) {
    return { ok: false, error: makeAiError('no_output', 'Unexpected generateContent response shape') };
  }
  const body = parsed.data;
  const candidate = body.candidates?.[0];
  return {
    ok: true,
    value: {
      parts: candidate?.content?.parts ?? [],
      finishReason: candidate?.finishReason ?? null,
      finishMessage: candidate?.finishMessage ?? null,
      blockReason: body.promptFeedback?.blockReason ?? null,
      responseId: body.responseId ?? null,
      modelVersion: body.modelVersion ?? null,
    },
  };
}

// finishReason values that mean the content filters stopped the output.
const SAFETY_FINISH_REASONS = new Set(['SAFETY', 'IMAGE_SAFETY', 'PROHIBITED_CONTENT', 'IMAGE_PROHIBITED_CONTENT', 'BLOCKLIST', 'SPII']);

// A 200 response with nothing usable in it: safety_blocked when the filters fired, otherwise no_output.
function emptyResponseError(content: ParsedContent, expected: 'image' | 'text'): ClassifiedError {
  const summary = JSON.stringify({
    blockReason: content.blockReason,
    finishReason: content.finishReason,
    finishMessage: content.finishMessage,
    text: content.parts.map((part) => part.text ?? '').join('').slice(0, 500),
  });
  if (content.blockReason !== null && content.blockReason !== 'BLOCK_REASON_UNSPECIFIED') {
    return makeAiError('safety_blocked', `Prompt blocked by the provider (${content.blockReason})`, {
      providerReason: content.blockReason,
      rawBody: summary,
    });
  }
  if (content.finishReason !== null && SAFETY_FINISH_REASONS.has(content.finishReason)) {
    return makeAiError('safety_blocked', `Output blocked by the provider (${content.finishReason})`, {
      providerReason: content.finishReason,
      rawBody: summary,
    });
  }
  return makeAiError('no_output', `Response contained no ${expected} (finishReason=${content.finishReason ?? 'none'})`, {
    providerReason: content.finishReason,
    rawBody: summary,
  });
}

// The first inline image part of the first candidate. Interim "thought" images from thinking models are skipped.
export function parseImageResponse(json: unknown): AiResult<ImageResponse> {
  const content = parseGenerateContent(json);
  if (!content.ok) return content;
  const part = content.value.parts.find(
    (candidate) =>
      candidate.thought !== true &&
      typeof candidate.inlineData?.data === 'string' &&
      candidate.inlineData.data.length > 0 &&
      (candidate.inlineData.mimeType ?? 'image/png').startsWith('image/'),
  );
  if (part?.inlineData?.data === undefined || part.inlineData.data === null) {
    return { ok: false, error: emptyResponseError(content.value, 'image') };
  }
  return {
    ok: true,
    value: {
      bytes: fromBase64(part.inlineData.data),
      mimeType: part.inlineData.mimeType ?? 'image/png',
      responseId: content.value.responseId,
      modelVersion: content.value.modelVersion,
    },
  };
}

function stripCodeFence(text: string): string {
  const match = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(text.trim());
  return match?.[1] ?? text.trim();
}

export function parsePlanResponse(json: unknown): AiResult<PlanResponse> {
  const content = parseGenerateContent(json);
  if (!content.ok) return content;
  const rawText = content.value.parts
    .filter((part) => part.thought !== true && typeof part.text === 'string')
    .map((part) => part.text ?? '')
    .join('');
  if (rawText.trim().length === 0) return { ok: false, error: emptyResponseError(content.value, 'text') };
  const parsed = parseJson(stripCodeFence(rawText));
  if (!parsed.ok) {
    // Text cut short by the content filters is a safety block, not a malformed plan.
    const blocked = emptyResponseError(content.value, 'text');
    if (blocked.kind === 'safety_blocked') return { ok: false, error: blocked };
    return {
      ok: false,
      error: makeAiError(
        'no_output',
        `Planner returned text that is not valid JSON (finishReason=${content.value.finishReason ?? 'none'})`,
        { providerReason: content.value.finishReason, rawBody: rawText },
      ),
    };
  }
  return {
    ok: true,
    value: {
      json: parsed.value,
      rawText,
      responseId: content.value.responseId,
      modelVersion: content.value.modelVersion,
    },
  };
}
