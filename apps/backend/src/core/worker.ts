import type { ConfigService } from './config';
import type { Logger } from './logger';

export interface WorkerState {
  lastTickAt: Date | null;
}

export function createWorkerState(): WorkerState {
  return { lastTickAt: null };
}

export interface WorkerHandle {
  stop(): void;
}

// Phase 0 stub: only records lastTickAt every queue.tickMs (read live). The queue module replaces it.
export function startWorkerStub(options: { config: ConfigService; logger: Logger; state: WorkerState }): WorkerHandle {
  let stopped = false;
  let timer: NodeJS.Timeout | undefined;

  const tick = (): void => {
    if (stopped) return;
    options.state.lastTickAt = new Date();
    timer = setTimeout(tick, options.config.get().queue.tickMs);
  };

  options.logger.info('worker loop started (stub)');
  tick();

  return {
    stop() {
      stopped = true;
      if (timer !== undefined) clearTimeout(timer);
    },
  };
}
