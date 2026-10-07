import type { QueueConfig } from '@rs/shared';

const MAX_JITTER_MS = 1000;

// SPEC 11.1: min(backoffBaseMs x 2^(attempts-1) + jitter of 0 to 1000 ms, backoffMaxMs).
// `attempts` is the number of attempts already made (the claim that just failed included).
export function backoffMs(attempts: number, config: QueueConfig, random: () => number): number {
  const exponent = Math.min(Math.max(attempts - 1, 0), 30);
  const jitter = Math.round(random() * MAX_JITTER_MS);
  return Math.min(config.backoffBaseMs * 2 ** exponent + jitter, config.backoffMaxMs);
}
