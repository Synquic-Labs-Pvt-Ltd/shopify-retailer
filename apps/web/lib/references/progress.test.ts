import { describe, expect, it } from 'vitest';
import { createProgressStepper } from './progress';
import { createTaskQueue } from './uploadQueue';

describe('createProgressStepper', () => {
  it('emits once per step and always the final 100%', () => {
    const seen: number[] = [];
    const report = createProgressStepper((fraction) => seen.push(fraction));
    for (const fraction of [0.01, 0.039, 0.04, 0.05, 0.079, 0.08, 0.5, 0.999, 1, 1]) report(fraction);
    expect(seen).toEqual([0.04, 0.08, 0.5, 0.999, 1]);
  });

  it('tolerates float noise at a step boundary', () => {
    const seen: number[] = [];
    const report = createProgressStepper((fraction) => seen.push(fraction));
    report(0.05);
    report(0.09);
    expect(seen).toEqual([0.05, 0.09]);
  });

  it('honours another step', () => {
    const seen: number[] = [];
    const report = createProgressStepper((fraction) => seen.push(fraction), 0.25);
    for (const fraction of [0.1, 0.25, 0.4, 0.5, 0.8]) report(fraction);
    expect(seen).toEqual([0.25, 0.5, 0.8]);
  });
});

describe('createTaskQueue', () => {
  function deferred() {
    let resolve: () => void = () => undefined;
    const promise = new Promise<void>((res) => {
      resolve = res;
    });
    return { promise, resolve };
  }

  it('runs at most `limit` tasks and starts the next when one finishes', async () => {
    const queue = createTaskQueue(2);
    const gates = [deferred(), deferred(), deferred()];
    const started: number[] = [];
    const runs = gates.map((gate, index) =>
      queue.run(async () => {
        started.push(index);
        await gate.promise;
        return index;
      }),
    );
    await Promise.resolve();
    expect(started).toEqual([0, 1]);
    expect(queue.running).toBe(2);
    expect(queue.pending).toBe(1);

    gates[1]?.resolve();
    await runs[1];
    await Promise.resolve();
    expect(started).toEqual([0, 1, 2]);

    gates[0]?.resolve();
    gates[2]?.resolve();
    expect(await Promise.all(runs)).toEqual([0, 1, 2]);
    expect(queue.running).toBe(0);
  });

  it('frees the slot when a task throws, even synchronously', async () => {
    const queue = createTaskQueue(1);
    const failing = queue.run(() => {
      throw new Error('boom');
    });
    const after = queue.run(async () => 'ok');
    await expect(failing).rejects.toThrow('boom');
    expect(await after).toBe('ok');
  });
});
