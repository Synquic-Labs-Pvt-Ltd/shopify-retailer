// Failures of the byte transfer to the staged target. The message of an UploadError is meant for the user.

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

// The request never produced an HTTP status (xhr.status 0): offline, DNS, TLS, or the browser blocked it.
// `progressed` tells whether any bytes went out before it failed.
export class UploadNetworkError extends UploadError {
  readonly progressed: boolean;

  constructor(progressed: boolean) {
    super('The upload failed. Check your connection.');
    this.name = 'UploadNetworkError';
    this.progressed = progressed;
  }
}

// The browser refused the cross-origin upload before a single byte left (typically CORS on the staged
// target). Not a flaky network: retrying the same transport will not help.
export class UploadBlockedError extends UploadError {
  constructor() {
    super(
      "The upload could not reach Shopify's file storage. If you are online, your browser may have blocked it. " +
        'Try again; if it keeps failing, contact support.',
    );
    this.name = 'UploadBlockedError';
  }
}

export class UploadNotImplementedError extends UploadError {
  constructor() {
    super('Uploading through the app server is not available yet.');
    this.name = 'UploadNotImplementedError';
  }
}
