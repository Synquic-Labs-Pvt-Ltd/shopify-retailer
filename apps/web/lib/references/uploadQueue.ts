// Runs tasks in order with at most `limit` of them in flight. A task that throws frees its slot like any other.
export interface TaskQueue {
  run<T>(task: () => Promise<T>): Promise<T>;
  readonly running: number;
  readonly pending: number;
}

export function createTaskQueue(limit: number): TaskQueue {
  const waiting: (() => void)[] = [];
  let running = 0;

  const next = (): void => {
    if (running >= limit) return;
    waiting.shift()?.();
  };

  return {
    run: (task) =>
      new Promise((resolve, reject) => {
        const start = (): void => {
          running += 1;
          (async () => task())()
            .then(resolve, reject)
            .finally(() => {
              running -= 1;
              next();
            });
        };
        waiting.push(start);
        next();
      }),
    get running() {
      return running;
    },
    get pending() {
      return waiting.length;
    },
  };
}
