import type { UploadTarget } from '@rs/shared';

export interface UploadFile {
  uri: string;
  name: string;
  mimeType: string;
}

export class UploadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UploadError';
  }
}

export class UploadAbortedError extends Error {
  constructor() {
    super('Upload cancelled');
    this.name = 'UploadAbortedError';
  }
}

const UPLOAD_TIMEOUT_MS = 10 * 60_000;

// SPEC 8.6 step 5: one multipart POST straight to the staged target, every form parameter first and the
// file last. React Native reports the bytes sent through xhr.upload (the native network module emits
// didSendNetworkData), which fetch cannot do.
function postMultipart(
  target: UploadTarget,
  file: UploadFile,
  onProgress: (fraction: number) => void,
  signal: AbortSignal,
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const form = new FormData();
    for (const { name, value } of target.parameters) form.append(name, value);
    form.append('file', { uri: file.uri, name: file.name, type: file.mimeType });

    const xhr = new XMLHttpRequest();
    const abort = () => xhr.abort();
    const settle = () => signal.removeEventListener('abort', abort);

    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable && event.total > 0) onProgress(Math.min(1, event.loaded / event.total));
    };
    xhr.onload = () => {
      settle();
      if (xhr.status >= 200 && xhr.status < 300) resolve();
      else reject(new UploadError(`The upload was rejected (HTTP ${xhr.status}).`));
    };
    xhr.onerror = () => {
      settle();
      reject(new UploadError('The upload failed. Check your connection.'));
    };
    xhr.ontimeout = () => {
      settle();
      reject(new UploadError('The upload timed out.'));
    };
    xhr.onabort = () => {
      settle();
      reject(new UploadAbortedError());
    };

    signal.addEventListener('abort', abort);
    if (signal.aborted) {
      abort();
      return;
    }
    xhr.open(target.method, target.url);
    xhr.timeout = UPLOAD_TIMEOUT_MS;
    xhr.send(form);
  });
}

// Mock mode hands out mock:// targets. The POST is replaced by timed fake progress; a target whose url has
// fail=1 stops partway with an error, so the retry path can be demonstrated.
function simulateUpload(target: UploadTarget, onProgress: (fraction: number) => void, signal: AbortSignal): Promise<void> {
  const STEPS = 12;
  const failsAt = target.url.includes('fail=1') ? 7 : -1;
  return new Promise<void>((resolve, reject) => {
    let step = 0;
    const abort = () => {
      clearInterval(timer);
      reject(new UploadAbortedError());
    };
    const timer = setInterval(() => {
      step += 1;
      onProgress(step / STEPS);
      if (step === failsAt) {
        clearInterval(timer);
        signal.removeEventListener('abort', abort);
        reject(new UploadError('The upload failed (simulated in mock mode).'));
      } else if (step >= STEPS) {
        clearInterval(timer);
        signal.removeEventListener('abort', abort);
        resolve();
      }
    }, 110);
    signal.addEventListener('abort', abort);
  });
}

export function postToTarget(
  target: UploadTarget,
  file: UploadFile,
  onProgress: (fraction: number) => void,
  signal: AbortSignal,
): Promise<void> {
  return target.url.startsWith('mock://')
    ? simulateUpload(target, onProgress, signal)
    : postMultipart(target, file, onProgress, signal);
}
