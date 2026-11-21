import type { AiProvider, AiResult, ClassifiedError, ModelTarget } from './index';
import { buildImageBody, buildPlanBody, parseImageResponse, parsePlanResponse, type ImageOptions } from './gemini-content';
import { requestJson, type HttpContext } from './http';

// The planner and image calls, identical on Vertex and AI Studio apart from the URL and the auth header.

export interface PreparedCall {
  url: string;
  headers: Record<string, string>;
}

// Resolves the URL and headers for a method on the target model, or an error when credentials are missing.
export type PrepareCall = (target: ModelTarget, method: string) => Promise<AiResult<PreparedCall>>;

const SIZE_REJECTED = /image[_ ]?size/i;
const OUTPUT_REJECTED = /image[_ ]?output[_ ]?options|output[_ ]?mime|compression[_ ]?quality/i;

// SPEC 24 leaves open which models accept imageSize and the output options. A 400 that names one of them means "this
// model does not support it". Only the option the error names is dropped, never both: a model that takes imageSize
// but not the output options must still get imageSize, or it would quietly return its default (1K) size. Returns
// null when the error names nothing that is still being sent.
export function withoutRejectedOptions(error: ClassifiedError, current: ImageOptions): ImageOptions | null {
  if (error.kind !== 'invalid_request') return null;
  const next: ImageOptions = {
    sendSize: current.sendSize && !SIZE_REJECTED.test(error.message),
    sendOutputOptions: current.sendOutputOptions && !OUTPUT_REJECTED.test(error.message),
  };
  return next.sendSize === current.sendSize && next.sendOutputOptions === current.sendOutputOptions ? null : next;
}

export function createGeminiContentApi(
  ctx: HttpContext,
  prepare: PrepareCall,
  imageOptions: ImageOptions,
): Pick<AiProvider, 'plan' | 'generateImage'> {
  // What each model has turned out to accept, so only the first image request per model and process pays for the
  // discovery (at most one failed call per option).
  const acceptedOptions = new Map<string, ImageOptions>();

  return {
    async plan(request) {
      const prepared = await prepare(request, 'generateContent');
      if (!prepared.ok) return prepared;
      const response = await requestJson(ctx, {
        op: `${ctx.provider}.generateContent.plan`,
        url: prepared.value.url,
        headers: prepared.value.headers,
        body: buildPlanBody(request),
        signal: request.signal,
      });
      return response.ok ? parsePlanResponse(response.value) : response;
    },

    async generateImage(request) {
      const prepared = await prepare(request, 'generateContent');
      if (!prepared.ok) return prepared;
      const post = (options: ImageOptions): Promise<AiResult<unknown>> =>
        requestJson(ctx, {
          op: `${ctx.provider}.generateContent.image`,
          url: prepared.value.url,
          headers: prepared.value.headers,
          body: buildImageBody(request, options),
          signal: request.signal,
        });

      let options = acceptedOptions.get(request.model) ?? imageOptions;
      let response = await post(options);
      // Each pass drops at least one option, so this ends after at most two retries.
      while (!response.ok) {
        const next = withoutRejectedOptions(response.error, options);
        if (next === null) break;
        const dropped = [options.sendSize && !next.sendSize ? 'imageSize' : null, options.sendOutputOptions && !next.sendOutputOptions ? 'imageOutputOptions' : null].filter(
          (name): name is string => name !== null,
        );
        ctx.logger.warn(
          { provider: ctx.provider, model: request.model, dropped },
          `image option rejected by the model (${dropped.join(', ')}), retrying without it${dropped.includes('imageSize') ? ': this model returns its default image size' : ''}`,
        );
        options = next;
        acceptedOptions.set(request.model, next);
        response = await post(options);
      }
      return response.ok ? parseImageResponse(response.value) : response;
    },
  };
}
