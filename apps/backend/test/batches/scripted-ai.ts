import type {
  AiProvider,
  AiResult,
  AiService,
  ClassifiedError,
  ImageRequest,
  ImageResponse,
  PlanRequest,
  PlanResponse,
  VideoOperation,
  VideoPollRequest,
  VideoPollResponse,
  VideoSubmitRequest,
} from '../../src/modules/ai';
import { classifyAiError, makeAiError } from '../../src/modules/ai';
import { fixtureText } from '../ai/helpers';

// Wraps the real fake provider. Every call is recorded; a hook can answer instead of the fake provider
// (return undefined to delegate), which is how tests script provider failures.
type Hook<Req, Res> = (request: Req, call: number) => AiResult<Res> | undefined | Promise<AiResult<Res> | undefined>;

export interface ScriptedAi {
  service: AiService;
  calls: { plan: PlanRequest[]; image: ImageRequest[]; submit: VideoSubmitRequest[]; poll: VideoPollRequest[] };
  hooks: {
    plan?: Hook<PlanRequest, PlanResponse>;
    image?: Hook<ImageRequest, ImageResponse>;
    submit?: Hook<VideoSubmitRequest, VideoOperation>;
    poll?: Hook<VideoPollRequest, VideoPollResponse>;
  };
}

export function wrapProvider(inner: AiProvider, name: AiProvider['name']): { provider: AiProvider; script: Omit<ScriptedAi, 'service'> } {
  const script: Omit<ScriptedAi, 'service'> = { calls: { plan: [], image: [], submit: [], poll: [] }, hooks: {} };
  const provider: AiProvider = {
    name,
    async plan(request) {
      script.calls.plan.push(request);
      return (await script.hooks.plan?.(request, script.calls.plan.length)) ?? inner.plan(request);
    },
    async generateImage(request) {
      script.calls.image.push(request);
      return (await script.hooks.image?.(request, script.calls.image.length)) ?? inner.generateImage(request);
    },
    async submitVideo(request) {
      script.calls.submit.push(request);
      return (await script.hooks.submit?.(request, script.calls.submit.length)) ?? inner.submitVideo(request);
    },
    async pollVideo(request) {
      script.calls.poll.push(request);
      return (await script.hooks.poll?.(request, script.calls.poll.length)) ?? inner.pollVideo(request);
    },
  };
  return { provider, script };
}

export function createScriptedAi(real: AiService): ScriptedAi {
  const { provider, script } = wrapProvider(real.getProvider('fake'), 'fake');
  return { ...script, service: { getProvider: () => provider, renderPrompt: real.renderPrompt } };
}

// Classified errors built from the recorded provider bodies, so tests go through the real classifier.
export function recordedError(status: number, fixture: string): ClassifiedError {
  return classifyAiError(status, fixtureText(fixture));
}

export const rateLimited = (): ClassifiedError => recordedError(429, '429-per-minute-retryinfo.json');
export const dailyQuota = (): ClassifiedError => recordedError(429, '429-vertex-quota-per-day-errorinfo.json');
export const prepayDepleted = (): ClassifiedError => recordedError(429, '429-prepay-credits-depleted.json');
export const overloaded = (): ClassifiedError => recordedError(503, '503-model-overloaded.json');
export const invalidArgument = (): ClassifiedError => recordedError(400, '400-invalid-argument.json');
export const safetyBlocked = (): ClassifiedError =>
  makeAiError('safety_blocked', 'Blocked by the provider safety filters', { providerReason: 'IMAGE_SAFETY' });

export const failWith = <T>(error: ClassifiedError): AiResult<T> => ({ ok: false, error });
