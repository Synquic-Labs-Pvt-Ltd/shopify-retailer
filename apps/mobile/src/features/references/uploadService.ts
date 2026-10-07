import type { MediaObject, UploadFileRequest, UploadTarget } from '@rs/shared';
import { api } from '../../api/client';
import { errorMessage } from '../../api/errors';
import { useDraftStore, type DraftReference } from '../../state/draft';
import { postToTarget, UploadAbortedError, UploadError } from './uploadTarget';

// The staged upload of SPEC 8.6, outside React so it keeps running while the screen is closed:
// POST /media/uploads -> multipart POST to the target (with progress) -> POST /media/:id/complete.
// Afterwards a reference is "processing" and useReferenceProcessing polls GET /media until it is ready.

const CONCURRENT_UPLOADS = 2;
// Progress is written to the persisted draft, so only steps of 4% are stored.
const PROGRESS_STEP = 0.04;

const active = new Map<string, AbortController>();

interface Located {
  ref: DraftReference;
  // null for a common reference.
  productId: string | null;
}

function locate(clientId: string): Located | null {
  const state = useDraftStore.getState();
  const common = state.commonRefs.find((ref) => ref.clientId === clientId);
  if (common !== undefined) return { ref: common, productId: null };
  for (const [productId, refs] of Object.entries(state.productRefs)) {
    const ref = refs.find((candidate) => candidate.clientId === clientId);
    if (ref !== undefined) return { ref, productId };
  }
  return null;
}

function patch(clientId: string, changes: Partial<DraftReference>): void {
  useDraftStore.getState().updateRef(clientId, changes);
}

function fail(clientId: string, message: string): void {
  patch(clientId, { status: 'failed', progress: 0, error: message });
}

function deleteQuietly(mediaId: string): void {
  api.media.remove(mediaId).catch(() => undefined);
}

function toUploadFile({ ref, productId }: Located): UploadFileRequest {
  return {
    clientId: ref.clientId,
    filename: ref.filename,
    mimeType: ref.mimeType,
    fileSize: ref.fileSize,
    durationSec: ref.durationSec !== null && ref.durationSec > 0 ? ref.durationSec : undefined,
    scope: productId === null ? 'common' : 'product',
    productGid: productId ?? undefined,
  };
}

// Maps the server's media status onto the slot state.
export function applyMediaStatus(clientId: string, media: MediaObject): void {
  switch (media.status) {
    case 'ready':
      patch(clientId, { status: 'ready', progress: 1, previewUrl: media.previewUrl, error: null });
      return;
    case 'failed':
    case 'deleted':
      fail(clientId, 'The store could not process this file.');
      return;
    case 'awaiting_upload':
    case 'processing':
      patch(clientId, { status: 'processing', progress: 1 });
  }
}

async function uploadOne(clientId: string, target: UploadTarget): Promise<boolean> {
  const located = locate(clientId);
  if (located === null) {
    deleteQuietly(target.mediaId);
    return true;
  }
  patch(clientId, { mediaId: target.mediaId, status: 'uploading', progress: 0, error: null });

  const controller = new AbortController();
  active.set(clientId, controller);
  let lastReported = 0;
  try {
    await postToTarget(
      target,
      { uri: located.ref.localUri, name: located.ref.filename, mimeType: located.ref.mimeType },
      (fraction) => {
        if (fraction - lastReported >= PROGRESS_STEP || fraction >= 1) {
          lastReported = fraction;
          patch(clientId, { progress: fraction });
        }
      },
      controller.signal,
    );
    const media = await api.media.complete(target.mediaId);
    if (locate(clientId) === null) {
      deleteQuietly(target.mediaId);
      return true;
    }
    applyMediaStatus(clientId, media);
    return media.status !== 'failed' && media.status !== 'deleted';
  } catch (error) {
    if (error instanceof UploadAbortedError) return true;
    fail(clientId, error instanceof UploadError ? error.message : errorMessage(error, 'The upload failed.'));
    return false;
  } finally {
    active.delete(clientId);
  }
}

async function runPool<T>(items: readonly T[], limit: number, task: (item: T) => Promise<boolean>): Promise<number> {
  const queue = [...items];
  let failures = 0;
  const worker = async (): Promise<void> => {
    for (let item = queue.shift(); item !== undefined; item = queue.shift()) {
      if (!(await task(item))) failures += 1;
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, queue.length) }, worker));
  return failures;
}

// Uploads references that already sit in the draft with their final local file (status uploading).
// Resolves with the number of uploads that failed; the others are processing or ready.
export async function enqueueUploads(clientIds: readonly string[]): Promise<number> {
  const entries = clientIds.flatMap((id) => locate(id) ?? []);
  if (entries.length === 0) return 0;

  let targets: UploadTarget[];
  try {
    targets = (await api.media.createUploads({ files: entries.map(toUploadFile) })).targets;
  } catch (error) {
    const message = errorMessage(error, 'Could not start the upload.');
    for (const { ref } of entries) fail(ref.clientId, message);
    return entries.length;
  }

  const byClientId = new Map(targets.map((target) => [target.clientId, target]));
  let missing = 0;
  const ready: { clientId: string; target: UploadTarget }[] = [];
  for (const { ref } of entries) {
    const target = byClientId.get(ref.clientId);
    if (target === undefined) {
      fail(ref.clientId, 'The server did not return an upload target.');
      missing += 1;
    } else {
      ready.push({ clientId: ref.clientId, target });
    }
  }
  return missing + (await runPool(ready, CONCURRENT_UPLOADS, ({ clientId, target }) => uploadOne(clientId, target)));
}

// Restarts a failed slot from its local file. The half-finished media record is dropped first.
export async function retryUpload(clientId: string): Promise<boolean> {
  const located = locate(clientId);
  if (located === null || located.ref.status !== 'failed') return true;
  if (located.ref.mediaId !== null) deleteQuietly(located.ref.mediaId);
  patch(clientId, { mediaId: null, status: 'uploading', progress: 0, error: null });
  return (await enqueueUploads([clientId])) === 0;
}

// Removes a slot: stops its upload and deletes the media record (DELETE /media/:id).
export function discardReference(clientId: string): void {
  const mediaId = locate(clientId)?.ref.mediaId;
  active.get(clientId)?.abort();
  useDraftStore.getState().removeRef(clientId);
  if (mediaId !== null && mediaId !== undefined) deleteQuietly(mediaId);
}

export function failReference(clientId: string, message: string): void {
  fail(clientId, message);
}
