// Thrown by StorageDriver.persistOutput when an output cannot be stored. The generation module maps it
// to the job error code shopify_upload_failed. retryable tells it whether another attempt can help:
// a timeout or a transport failure can, a file Shopify rejected outright cannot.
export class StorageUploadError extends Error {
  readonly code = 'shopify_upload_failed' as const;
  readonly retryable: boolean;

  constructor(message: string, retryable: boolean, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = 'StorageUploadError';
    this.retryable = retryable;
  }
}

export function describeError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
