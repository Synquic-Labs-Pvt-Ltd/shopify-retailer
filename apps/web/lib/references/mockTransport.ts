import type { UploadTransport } from './transport';
import { UploadAbortedError, UploadError } from './uploadErrors';

export const MOCK_TARGET_PREFIX = 'mock://';

export interface MockTransportOptions {
  steps?: number;
  stepMs?: number;
}

// Mock mode hands out mock:// targets. The POST is replaced by timed fake progress (12 steps of 125 ms, about
// 1.5 s). The mock backend gives every 4th new upload a url with fail=1: that one stops partway with an error
// so the retry path can be shown (every 7th file then fails in processing, which the backend simulates).
export function createMockTransport(options: MockTransportOptions = {}): UploadTransport {
  const { steps = 12, stepMs = 125 } = options;
  return {
    upload: (target, _file, onProgress, signal) =>
      new Promise<void>((resolve, reject) => {
        if (signal.aborted) {
          reject(new UploadAbortedError());
          return;
        }
        const failsAt = target.url.includes('fail=1') ? Math.ceil(steps * 0.6) : -1;
        let step = 0;
        const abort = (): void => {
          clearInterval(timer);
          reject(new UploadAbortedError());
        };
        const timer = setInterval(() => {
          step += 1;
          onProgress(step / steps);
          if (step === failsAt) {
            clearInterval(timer);
            signal.removeEventListener('abort', abort);
            reject(new UploadError('The upload failed (simulated in mock mode).'));
          } else if (step >= steps) {
            clearInterval(timer);
            signal.removeEventListener('abort', abort);
            resolve();
          }
        }, stepMs);
        signal.addEventListener('abort', abort, { once: true });
      }),
  };
}

export const mockTransport = createMockTransport();
