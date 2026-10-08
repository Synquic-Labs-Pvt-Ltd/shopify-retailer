import type { MediaType } from '@rs/shared';
import type { DraftReference, ReferenceTarget } from '@/lib/state/draftTypes';
import type { FileRegistry } from '@/lib/state/fileRegistry';
import { newId } from '@/lib/state/ids';
import { withMimeType } from './fileTypes';
import { checkPreparedSize, limitMessage, remainingRoom, validateFile, type ReferenceLimits } from './limits';
import { prepareImage, type ImageDecoder } from './prepareImage';
import { readVideo, type VideoLoader } from './readVideo';
import { createTaskQueue } from './uploadQueue';
import type { DraftAccess, UploadService, UploadSummary } from './uploadService';

// Decoding several large photos at once can exhaust memory: prepare two at a time.
const CONCURRENT_PREPARES = 2;
const MB = 1024 * 1024;

export interface AddFilesDeps {
  draft: DraftAccess;
  files: FileRegistry;
  uploads: Pick<UploadService, 'enqueue' | 'remove'>;
  images: ImageDecoder;
  videos: VideoLoader;
  newId?: () => string;
}

export interface AddFilesResult {
  // Slots created and handed to the uploader.
  added: string[];
  // One sentence per skipped file or reached limit, ready for a toast or banner.
  problems: string[];
  uploads: UploadSummary;
}

interface Accepted {
  file: File;
  mediaType: MediaType;
  mimeType: string;
  durationSec: number | null;
  poster: string | null;
}

type Inspected = ({ ok: true } & Accepted) | { ok: false; file: File; reason: string };

// The video's length is the only thing worth reading the file for, so a file that already fails on type or size
// is rejected without touching it (a duration of 0 passes the length check and is replaced below).
async function inspect(file: File, limits: ReferenceLimits, deps: AddFilesDeps): Promise<Inspected> {
  const early = validateFile(file, { durationSec: 0 }, limits);
  if (!early.ok) return { ok: false, file, reason: early.reason };

  let durationSec: number | null = null;
  let poster: string | null = null;
  if (early.mediaType === 'video') {
    try {
      const info = await readVideo(file, { loader: deps.videos });
      durationSec = info.durationSec;
      poster = info.poster;
    } catch {
      // Leaves the length unknown: validateFile reports it.
    }
    const checked = validateFile(file, { durationSec }, limits);
    if (!checked.ok) return { ok: false, file, reason: checked.reason };
  }
  return { ok: true, file, mediaType: early.mediaType, mimeType: early.mimeType, durationSec, poster };
}

function newReference(clientId: string, item: Accepted): DraftReference {
  return {
    clientId,
    mediaId: null,
    mediaType: item.mediaType,
    filename: item.file.name,
    mimeType: item.mimeType,
    fileSize: item.file.size,
    durationSec: item.durationSec,
    status: 'uploading',
    progress: 0,
    previewUrl: item.poster,
    error: null,
  };
}

// Downscales an image slot and swaps the prepared file in. Resolves with a problem sentence, or null when fine.
async function prepare(
  clientId: string,
  item: Accepted,
  limits: ReferenceLimits,
  deps: AddFilesDeps,
): Promise<string | null> {
  if (item.mediaType === 'video') return null;
  try {
    const prepared = await prepareImage(item.file, { decoder: deps.images, maxBytes: limits.maxImageMB * MB });
    const tooLarge = checkPreparedSize(prepared.file.size, 'image', limits);
    if (tooLarge !== null) return tooLarge;
    // The merchant may have removed the slot while it was being prepared.
    if (deps.files.has(clientId)) {
      deps.files.set(clientId, prepared.file);
      deps.draft.getState().updateRef(clientId, {
        filename: prepared.file.name,
        mimeType: prepared.file.type,
        fileSize: prepared.file.size,
        previewUrl: prepared.thumbnail,
      });
    }
    return null;
  } catch {
    return 'The image could not be processed.';
  }
}

export function summarizeProblems(problems: readonly string[]): string {
  const [first] = problems;
  if (first === undefined) return '';
  return problems.length === 1 ? first : `${first} (and ${problems.length - 1} more problems)`;
}

// The pipeline for the files a merchant picked or dropped on one target: check the limits, read videos, add a
// slot per file, downscale images, then hand the slots to the uploader. One bad file never stops the others.
export async function addFiles(
  target: ReferenceTarget,
  picked: readonly File[],
  limits: ReferenceLimits,
  deps: AddFilesDeps,
): Promise<AddFilesResult> {
  const problems: string[] = [];
  const room = remainingRoom(target, limits, deps.draft.getState());
  if (picked.length > room) problems.push(limitMessage(target, limits));
  const inspected = await Promise.all(picked.slice(0, room).map((file) => inspect(file, limits, deps)));

  // The draft may have changed while videos were being read: count the room again, then add the slots.
  let roomNow = remainingRoom(target, limits, deps.draft.getState());
  const accepted: { clientId: string; item: Accepted }[] = [];
  for (const item of inspected) {
    if (!item.ok) {
      problems.push(`${item.file.name}: ${item.reason}`);
    } else if (roomNow > 0) {
      const clientId = (deps.newId ?? newId)();
      deps.files.set(clientId, withMimeType(item.file, item.mimeType));
      deps.draft.getState().addRef(target, newReference(clientId, item));
      accepted.push({ clientId, item });
      roomNow -= 1;
    } else if (!problems.includes(limitMessage(target, limits))) {
      problems.push(limitMessage(target, limits));
    }
  }

  const queue = createTaskQueue(CONCURRENT_PREPARES);
  const failures = await Promise.all(
    accepted.map(({ clientId, item }) => queue.run(() => prepare(clientId, item, limits, deps))),
  );
  const ready: string[] = [];
  accepted.forEach(({ clientId, item }, index) => {
    const problem = failures[index] ?? null;
    if (problem !== null) {
      deps.uploads.remove(clientId);
      problems.push(`${item.file.name}: ${problem}`);
    } else if (deps.files.has(clientId)) {
      ready.push(clientId);
    }
  });

  return { added: ready, problems, uploads: await deps.uploads.enqueue(ready) };
}
