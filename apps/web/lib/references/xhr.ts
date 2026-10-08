// A thin seam over XMLHttpRequest, which is the only browser API that reports upload progress (fetch cannot).
// The real thing is createBrowserXhr; tests pass a fake factory.

export type XhrOutcome = 'load' | 'error' | 'timeout' | 'abort';

export interface XhrHandle {
  open(method: string, url: string, timeoutMs: number): void;
  send(body: FormData): void;
  abort(): void;
  // The HTTP status; 0 until a response arrives (and after a network or CORS failure).
  status(): number;
  onUploadProgress(listener: (loaded: number, total: number) => void): void;
  // Called once, with how the request ended.
  onSettled(listener: (outcome: XhrOutcome) => void): void;
}

export type XhrFactory = () => XhrHandle;

export const createBrowserXhr: XhrFactory = () => {
  const xhr = new XMLHttpRequest();
  return {
    open: (method, url, timeoutMs) => {
      xhr.open(method, url);
      xhr.timeout = timeoutMs;
    },
    send: (body) => xhr.send(body),
    abort: () => xhr.abort(),
    status: () => xhr.status,
    onUploadProgress: (listener) => {
      xhr.upload.onprogress = (event) => {
        if (event.lengthComputable) listener(event.loaded, event.total);
      };
    },
    onSettled: (listener) => {
      for (const outcome of ['load', 'error', 'timeout', 'abort'] as const) {
        xhr.addEventListener(outcome, () => listener(outcome), { once: true });
      }
    },
  };
};
