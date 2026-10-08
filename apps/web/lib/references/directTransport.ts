import type { UploadTransport } from './transport';
import { UploadAbortedError, UploadError, UploadNetworkError } from './uploadErrors';
import { createBrowserXhr, type XhrFactory } from './xhr';

export const UPLOAD_TIMEOUT_MS = 10 * 60_000;

// SPEC 8.6 step 5: one multipart POST straight from the browser to the staged target, every form parameter
// first and the file last, with upload progress from XMLHttpRequest.
//
// UNVERIFIED: whether Shopify's staged-upload buckets answer a browser cross-origin request. Registering an
// upload progress listener makes the browser send a CORS preflight, and the response must also carry an
// Access-Control-Allow-Origin header for the page to read the status. Until a run against a real dev store
// settles this, a status-0 failure before any byte is sent is reported as UploadNetworkError(progressed:
// false) and the auto transport turns it into UploadBlockedError.
export function createDirectXhrTransport(
  factory: XhrFactory = createBrowserXhr,
  timeoutMs: number = UPLOAD_TIMEOUT_MS,
): UploadTransport {
  return {
    upload: (target, file, onProgress, signal) =>
      new Promise<void>((resolve, reject) => {
        if (signal.aborted) {
          reject(new UploadAbortedError());
          return;
        }
        const form = new FormData();
        for (const { name, value } of target.parameters) form.append(name, value);
        form.append('file', file, file.name);

        const xhr = factory();
        const abort = (): void => xhr.abort();
        let progressed = false;

        xhr.onUploadProgress((loaded, total) => {
          if (loaded > 0) progressed = true;
          if (total > 0) onProgress(Math.min(1, loaded / total));
        });
        xhr.onSettled((outcome) => {
          signal.removeEventListener('abort', abort);
          switch (outcome) {
            case 'load': {
              const status = xhr.status();
              if (status >= 200 && status < 300) resolve();
              else reject(new UploadError(`The upload was rejected (HTTP ${status}).`));
              return;
            }
            case 'error':
              reject(new UploadNetworkError(progressed));
              return;
            case 'timeout':
              reject(new UploadError('The upload timed out.'));
              return;
            case 'abort':
              reject(new UploadAbortedError());
          }
        });

        signal.addEventListener('abort', abort, { once: true });
        xhr.open(target.method, target.url, timeoutMs);
        xhr.send(form);
      }),
  };
}

export const directXhrTransport = createDirectXhrTransport();
