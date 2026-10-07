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

const NO_IMAGE_OPTIONS: ImageOptions = { sendSize: false, sendOutputOptions: false };
const OPTION_REJECTED = /image[_ ]?size|image[_ ]?output[_ ]?options|output[_ ]?mime|compression[_ ]?quality/i;

// SPEC 24 leaves open which models accept imageSize and JPEG output options. A 400 that names them is
// treated as "unsupported by this model": the call is retried once without them and the model is
// remembered, so only the first image request per model and process pays for the discovery.
function rejectsImageOptions(error: ClassifiedError): boolean {
  return error.kind === 'invalid_request' && OPTION_REJECTED.test(error.message);
}

export function createGeminiContentApi(
  ctx: HttpContext,
  prepare: PrepareCall,
  imageOptions: ImageOptions,
): Pick<AiProvider, 'plan' | 'generateImage'> {
  const modelsWithoutImageOptions = new Set<string>();

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

      const stripped = modelsWithoutImageOptions.has(request.model);
      let response = await post(stripped ? NO_IMAGE_OPTIONS : imageOptions);
      if (!response.ok && !stripped && rejectsImageOptions(response.error)) {
        modelsWithoutImageOptions.add(request.model);
        ctx.logger.warn({ provider: ctx.provider, model: request.model }, 'image options rejected, retrying without imageSize and output options');
        response = await post(NO_IMAGE_OPTIONS);
      }
      return response.ok ? parseImageResponse(response.value) : response;
    },
  };
}
