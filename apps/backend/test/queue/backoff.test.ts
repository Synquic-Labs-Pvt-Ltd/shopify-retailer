import { describe, expect, it } from 'vitest';
import { defaultGenerationConfig } from '@rs/shared';
import { backoffMs } from '../../src/modules/queue/backoff';

const queue = defaultGenerationConfig.queue;

describe('backoffMs', () => {
  it('is backoffBaseMs x 2^(attempts-1) with no jitter', () => {
    expect([1, 2, 3, 4].map((attempts) => backoffMs(attempts, queue, () => 0))).toEqual([5000, 10000, 20000, 40000]);
  });

  it('adds jitter of 0 to 1000 ms', () => {
    expect(backoffMs(1, queue, () => 0)).toBe(5000);
    expect(backoffMs(1, queue, () => 0.5)).toBe(5500);
    expect(backoffMs(1, queue, () => 1)).toBe(6000);
    expect(backoffMs(3, queue, () => 1)).toBe(21000);
  });

  it('caps the sum at backoffMaxMs', () => {
    const capped = { ...queue, backoffMaxMs: 12000 };
    expect([1, 2, 3, 9].map((attempts) => backoffMs(attempts, capped, () => 1))).toEqual([6000, 11000, 12000, 12000]);
  });

  it('survives absurd attempt counts', () => {
    expect(backoffMs(10_000, queue, () => 1)).toBe(queue.backoffMaxMs);
  });
});
