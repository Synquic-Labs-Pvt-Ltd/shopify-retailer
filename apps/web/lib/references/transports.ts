import { directXhrTransport } from './directTransport';
import { MOCK_TARGET_PREFIX, mockTransport } from './mockTransport';
import type { UploadTransport } from './transport';
import { UploadBlockedError, UploadNetworkError, UploadNotImplementedError } from './uploadErrors';

// Contingency adapter, NOT wired by default and NOT implemented in the backend yet. If a run against a real dev
// store shows that Shopify's staged-upload buckets reject browser uploads (CORS), the file can be streamed
// through the app instead: POST /api/v1/media/:id/content (session token auth, body = the file), and the backend
// forwards it to the staged target it created for that media record. Until that route exists this adapter only
// fails with a clear error. To switch over: pass it as the fallback of createAutoTransport.
export const proxyTransport: UploadTransport = {
  upload: () => Promise.reject(new UploadNotImplementedError()),
};

// Direct XHR first. A status-0 failure before any byte was sent is the signature of a blocked cross-origin
// request: with a fallback the file goes through that instead, without one the page gets an UploadBlockedError
// (a precise message, and a signal that retrying the same transport is pointless). A failure after some
// progress is an ordinary network error and is passed through.
export function createAutoTransport(direct: UploadTransport, fallback?: UploadTransport): UploadTransport {
  return {
    upload: async (target, file, onProgress, signal) => {
      try {
        await direct.upload(target, file, onProgress, signal);
      } catch (error) {
        if (!(error instanceof UploadNetworkError) || error.progressed) throw error;
        if (fallback === undefined) throw new UploadBlockedError();
        await fallback.upload(target, file, onProgress, signal);
      }
    },
  };
}

export const autoTransport = createAutoTransport(directXhrTransport);

// mock:// targets (mock mode) are simulated, everything else goes to the real transport.
export function createRoutingTransport(mock: UploadTransport, real: UploadTransport): UploadTransport {
  return {
    upload: (target, file, onProgress, signal) =>
      (target.url.startsWith(MOCK_TARGET_PREFIX) ? mock : real).upload(target, file, onProgress, signal),
  };
}

export const defaultTransport = createRoutingTransport(mockTransport, autoTransport);
