// Reference upload pipeline (SPEC 8.6), kept outside React so uploads keep running while a page is unmounted.
//
//  1. addFiles (addFiles.ts) validates and prepares the picked files and puts one slot per file into the
//     draft (status 'uploading'), with the File itself in the in-memory file registry.
//  2. enqueue() stages the slots: POST /media/uploads (one request per 50 files) returns a target per slot.
//  3. Each staged slot waits in a queue, two uploads at a time, then the transport POSTs the file as multipart
//     form data to the target (see transports.ts). Progress reaches the draft in 4% steps.
//  4. POST /media/:id/complete moves the slot to 'processing' (or straight to 'ready').
//  5. The page polls GET /media?ids= (useMediaStatus) for processing slots and passes the answer to
//     applyMediaItems (processing.ts), which settles them as 'ready' or 'failed'.
//
// retry() restages a failed slot from its File (the old media record is deleted quietly first). remove()
// aborts a running upload, drops the slot and deletes the media record; DELETE answers 409 in_use when a batch
// still uses the media, which is ignored because the slot is gone from the draft either way.
import type { MediaObject, UploadFileRequest, UploadTarget } from '@rs/shared';
import type { Endpoints } from '@/lib/api/endpoints';
import { errorMessage } from '@/lib/api/errors';
import { findRef } from '@/lib/state/draftData';
import type { DraftReference, DraftState, ReferenceTarget } from '@/lib/state/draftTypes';
import type { FileRegistry } from '@/lib/state/fileRegistry';
import { createProgressStepper, PROGRESS_STEP } from './progress';
import type { UploadTransport } from './transport';
import { UploadAbortedError, UploadBlockedError, UploadError } from './uploadErrors';
import { createTaskQueue } from './uploadQueue';

export const CONCURRENT_UPLOADS = 2;
// POST /media/uploads accepts at most 50 files.
const MAX_FILES_PER_REQUEST = 50;

export const FILE_GONE_MESSAGE = 'The file is no longer available. Remove it and add it again.';
export const PROCESSING_FAILED_MESSAGE = 'Shopify could not process this file.';

// The part of the draft store the service uses; the real store and a test store both fit.
export interface DraftAccess {
  getState(): Pick<DraftState, 'commonRefs' | 'productRefs' | 'addRef' | 'updateRef' | 'removeRef'>;
}

export interface UploadServiceDeps {
  draft: DraftAccess;
  files: FileRegistry;
  api: Pick<Endpoints['media'], 'createUploads' | 'complete' | 'remove'>;
  transport: UploadTransport;
  concurrency?: number;
  progressStep?: number;
}

export interface UploadSummary {
  // Slots that ended 'failed' in this call (blocked ones included).
  failed: number;
  // At least one upload was refused by the browser before sending anything (UploadBlockedError).
  blocked: boolean;
}

export interface UploadService {
  // Stages and uploads slots that sit in the draft as 'uploading' with their File registered.
  enqueue(clientIds: readonly string[]): Promise<UploadSummary>;
  // Restarts a failed slot from its File. A slot without a File (after a reload) stays failed.
  retry(clientId: string): Promise<UploadSummary>;
  // Aborts the upload, drops the slot and deletes the media record.
  remove(clientId: string): void;
  fail(clientId: string, message: string): void;
  // True while a slot is waiting for a target, queued, or sending.
  isBusy(clientId: string): boolean;
}

// Maps the server's media status onto the slot.
export function applyMediaStatus(ref: DraftReference, media: MediaObject): DraftReference {
  switch (media.status) {
    case 'ready':
      return {
        ...ref,
        mediaId: media.id,
        status: 'ready',
        progress: 1,
        previewUrl: media.previewUrl ?? ref.previewUrl,
        error: null,
      };
    case 'failed':
    case 'deleted':
      return { ...ref, status: 'failed', progress: 0, error: PROCESSING_FAILED_MESSAGE };
    case 'awaiting_upload':
    case 'processing':
      return { ...ref, mediaId: media.id, status: 'processing', progress: 1 };
  }
}

// The sentence shown on a failed slot.
export function uploadErrorMessage(error: unknown): string {
  return error instanceof UploadError ? error.message : errorMessage(error, 'The upload failed.');
}

type Outcome = 'ok' | 'failed' | 'blocked';

interface Staged {
  clientId: string;
  target: UploadTarget;
}

function toUploadFile(ref: DraftReference, productId: string | null, file: File): UploadFileRequest {
  return {
    clientId: ref.clientId,
    filename: ref.filename,
    mimeType: ref.mimeType,
    fileSize: file.size,
    durationSec: ref.durationSec !== null && ref.durationSec > 0 ? ref.durationSec : undefined,
    scope: productId === null ? 'common' : 'product',
    productGid: productId ?? undefined,
  };
}

function productIdOf(target: ReferenceTarget): string | null {
  return target.kind === 'common' ? null : target.productId;
}

function chunk<T>(items: readonly T[], size: number): T[][] {
  const groups: T[][] = [];
  for (let start = 0; start < items.length; start += size) groups.push(items.slice(start, start + size));
  return groups;
}

export function createUploadService(deps: UploadServiceDeps): UploadService {
  const { draft, files, api, transport, progressStep = PROGRESS_STEP } = deps;
  const queue = createTaskQueue(deps.concurrency ?? CONCURRENT_UPLOADS);
  // Uploads that are sending right now, keyed by the slot's clientId.
  const uploads = new Map<string, AbortController>();
  // Slots between enqueue() and their outcome.
  const busy = new Set<string>();

  const locate = (clientId: string) => findRef(draft.getState(), clientId);
  const patch = (clientId: string, changes: Partial<DraftReference>): void =>
    draft.getState().updateRef(clientId, changes);
  const fail = (clientId: string, message: string): void =>
    patch(clientId, { status: 'failed', progress: 0, error: message });
  const dropRecord = (mediaId: string): void => {
    void (async () => api.remove(mediaId))().catch(() => undefined);
  };

  async function uploadOne({ clientId, target }: Staged): Promise<Outcome> {
    const located = locate(clientId);
    const file = files.get(clientId);
    if (located === null) {
      dropRecord(target.mediaId);
      return 'ok';
    }
    if (file === undefined) {
      fail(clientId, FILE_GONE_MESSAGE);
      return 'failed';
    }

    const controller = new AbortController();
    uploads.set(clientId, controller);
    patch(clientId, { mediaId: target.mediaId, status: 'uploading', progress: 0, error: null });
    try {
      const onProgress = createProgressStepper((fraction) => patch(clientId, { progress: fraction }), progressStep);
      await transport.upload(target, file, onProgress, controller.signal);
      const media = await api.complete(target.mediaId);
      const current = locate(clientId);
      if (current === null) {
        dropRecord(target.mediaId);
        return 'ok';
      }
      const next = applyMediaStatus(current.ref, media);
      patch(clientId, next);
      return next.status === 'failed' ? 'failed' : 'ok';
    } catch (error) {
      if (error instanceof UploadAbortedError) return 'ok';
      if (locate(clientId) === null) {
        dropRecord(target.mediaId);
        return 'ok';
      }
      fail(clientId, uploadErrorMessage(error));
      return error instanceof UploadBlockedError ? 'blocked' : 'failed';
    } finally {
      uploads.delete(clientId);
    }
  }

  // POST /media/uploads for the slots. A slot the server gave no target for is failed here.
  async function stage(ids: readonly string[]): Promise<{ staged: Staged[]; failed: string[] }> {
    const staged: Staged[] = [];
    const failed: string[] = [];
    for (const group of chunk(ids, MAX_FILES_PER_REQUEST)) {
      const requests: UploadFileRequest[] = [];
      for (const clientId of group) {
        const located = locate(clientId);
        const file = files.get(clientId);
        if (located === null) continue;
        if (file === undefined) {
          fail(clientId, FILE_GONE_MESSAGE);
          failed.push(clientId);
          continue;
        }
        requests.push(toUploadFile(located.ref, productIdOf(located.target), file));
      }
      if (requests.length === 0) continue;
      try {
        const { targets } = await api.createUploads({ files: requests });
        const byClientId = new Map(targets.map((target) => [target.clientId, target]));
        for (const { clientId } of requests) {
          const target = byClientId.get(clientId);
          if (target === undefined) {
            fail(clientId, 'The server did not return an upload target.');
            failed.push(clientId);
          } else {
            staged.push({ clientId, target });
          }
        }
      } catch (error) {
        const message = errorMessage(error, 'Could not start the upload.');
        for (const { clientId } of requests) {
          fail(clientId, message);
          failed.push(clientId);
        }
      }
    }
    return { staged, failed };
  }

  async function enqueue(clientIds: readonly string[]): Promise<UploadSummary> {
    const ids = [...new Set(clientIds)].filter((id) => !busy.has(id) && locate(id) !== null);
    for (const id of ids) busy.add(id);
    try {
      const { staged, failed } = await stage(ids);
      for (const id of failed) busy.delete(id);
      const outcomes = await Promise.all(
        staged.map(async (item) => {
          // Known from now on, so remove() can delete the record even while the slot is still queued.
          if (locate(item.clientId) !== null) patch(item.clientId, { mediaId: item.target.mediaId });
          try {
            return await queue.run(() => uploadOne(item));
          } finally {
            busy.delete(item.clientId);
          }
        }),
      );
      return {
        failed: failed.length + outcomes.filter((outcome) => outcome !== 'ok').length,
        blocked: outcomes.includes('blocked'),
      };
    } finally {
      for (const id of ids) busy.delete(id);
    }
  }

  return {
    enqueue,

    retry: async (clientId) => {
      const located = locate(clientId);
      if (located === null || located.ref.status !== 'failed' || busy.has(clientId)) {
        return { failed: 0, blocked: false };
      }
      if (!files.has(clientId)) {
        fail(clientId, FILE_GONE_MESSAGE);
        return { failed: 1, blocked: false };
      }
      if (located.ref.mediaId !== null) dropRecord(located.ref.mediaId);
      patch(clientId, { mediaId: null, status: 'uploading', progress: 0, error: null });
      return enqueue([clientId]);
    },

    remove: (clientId) => {
      const mediaId = locate(clientId)?.ref.mediaId ?? null;
      uploads.get(clientId)?.abort();
      draft.getState().removeRef(clientId);
      if (mediaId !== null) dropRecord(mediaId);
    },

    fail,

    isBusy: (clientId) => busy.has(clientId),
  };
}
