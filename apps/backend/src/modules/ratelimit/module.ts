import { createGovernor } from './governor';
import type { RateLimitModuleOptions, RateLimitService } from './index';
import { LaneStateModel, RateCounterModel } from './models';

// Wire once at boot: createRateLimitModule({ getConfig: () => config.get(), logger }).governor
// is what createQueueModule takes as `governor`.
export function createRateLimitModule(options: RateLimitModuleOptions): RateLimitService {
  return {
    governor: createGovernor(options),
    async ensureIndexes() {
      await Promise.all([RateCounterModel.createIndexes(), LaneStateModel.createIndexes()]);
    },
  };
}
