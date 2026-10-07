import { createImageHandler } from './image-handler';
import type { GenerationService } from './index';
import { createPlanHandler } from './plan-handler';
import { createRuntime, type GenerationDeps } from './runtime';
import { createVideoHandler } from './video-handler';

// Wire after the batches module, then register every handler with the queue runner:
//   for (const handler of generation.handlers) queue.runner.registerHandler(handler)
export function createGenerationModule(deps: GenerationDeps): GenerationService {
  const rt = createRuntime(deps);
  return { handlers: [createPlanHandler(rt), createImageHandler(rt), createVideoHandler(rt)] };
}
