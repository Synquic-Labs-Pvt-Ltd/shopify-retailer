import type { QueueModule, QueueModuleOptions } from './index';
import { JobModel } from './models';
import { createRunner } from './runner';
import { createJobStore } from './store';

// Wire once at boot, after createRateLimitModule:
//   const queue = createQueueModule({ getConfig: () => config.get(), governor, logger, onTerminal });
//   queue.runner.registerHandler(...); queue.runner.start();   // worker and all roles only
export function createQueueModule(options: QueueModuleOptions): QueueModule {
  const now = options.now ?? (() => new Date());
  return {
    store: createJobStore({ getConfig: options.getConfig, now }),
    runner: createRunner(options),
    async ensureIndexes() {
      await JobModel.createIndexes();
    },
  };
}
