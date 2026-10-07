export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export interface WaitOptions {
  timeoutMs?: number;
  intervalMs?: number;
  label?: string;
}

// Polls until check() returns a value (anything but null, undefined or false).
export async function waitFor<T>(check: () => Promise<T | null | undefined | false>, options: WaitOptions = {}): Promise<T> {
  const { timeoutMs = 30_000, intervalMs = 50, label = 'condition' } = options;
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await check();
    if (value !== null && value !== undefined && value !== false) return value;
    if (Date.now() > deadline) throw new Error(`Timed out after ${timeoutMs} ms waiting for ${label}`);
    await sleep(intervalMs);
  }
}
