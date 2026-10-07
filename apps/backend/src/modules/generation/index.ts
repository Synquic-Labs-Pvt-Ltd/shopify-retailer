import type { JobHandler } from '../queue';

export interface GenerationService {
  // Handlers for the plan, image and video job types, to register with the queue runner.
  readonly handlers: readonly JobHandler[];
}
