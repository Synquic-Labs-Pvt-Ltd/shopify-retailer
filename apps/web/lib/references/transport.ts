import type { UploadTarget } from '@rs/shared';

export type ProgressListener = (fraction: number) => void;

// Moves the bytes of one file to a staged upload target (SPEC 8.6 step 5). Resolves when the target accepted
// the file; rejects with an UploadError (or UploadAbortedError when the signal fired).
export interface UploadTransport {
  upload(target: UploadTarget, file: File, onProgress: ProgressListener, signal: AbortSignal): Promise<void>;
}
