import type { MediaType, ReferencesConfig, UploadFileRequest } from '@rs/shared';
import { AppError } from '../../core/errors';

const BYTES_PER_MB = 1024 * 1024;

export type UploadProblemCode =
  | 'duplicate_client_id'
  | 'unsupported_mime_type'
  | 'file_too_large'
  | 'duration_required'
  | 'video_too_long'
  | 'too_many_files';

export interface UploadProblem {
  clientId: string;
  code: UploadProblemCode;
  message: string;
}

export interface ValidatedUpload {
  file: UploadFileRequest;
  mediaType: MediaType;
  // Lower-cased.
  mimeType: string;
}

function mediaTypeOf(mimeType: string, limits: ReferencesConfig): MediaType | null {
  if (limits.imageMimeTypes.includes(mimeType)) return 'image';
  if (limits.videoMimeTypes.includes(mimeType)) return 'video';
  return null;
}

function checkFile(file: UploadFileRequest, mediaType: MediaType, limits: ReferencesConfig): UploadProblem[] {
  const problems: UploadProblem[] = [];
  const maxMb = mediaType === 'image' ? limits.maxImageMB : limits.maxVideoMB;
  if (file.fileSize > maxMb * BYTES_PER_MB) {
    problems.push({ clientId: file.clientId, code: 'file_too_large', message: `A ${mediaType} can be at most ${maxMb} MB` });
  }
  if (mediaType === 'video') {
    if (file.durationSec === undefined) {
      problems.push({ clientId: file.clientId, code: 'duration_required', message: 'durationSec is required for videos' });
    } else if (file.durationSec > limits.maxVideoSeconds) {
      problems.push({ clientId: file.clientId, code: 'video_too_long', message: `A video can be at most ${limits.maxVideoSeconds} seconds` });
    }
  }
  return problems;
}

// Files beyond the limit of their group are rejected, in request order.
function checkCounts(files: readonly UploadFileRequest[], limits: ReferencesConfig): UploadProblem[] {
  const problems: UploadProblem[] = [];
  const counts = new Map<string, number>();
  for (const file of files) {
    const group = file.scope === 'common' ? 'common' : `product:${file.productGid ?? ''}`;
    const next = (counts.get(group) ?? 0) + 1;
    counts.set(group, next);
    const max = file.scope === 'common' ? limits.maxCommon : limits.maxPerProduct;
    if (next > max) {
      const subject = file.scope === 'common' ? 'common references' : 'references per product';
      problems.push({ clientId: file.clientId, code: 'too_many_files', message: `At most ${max} ${subject} can be uploaded at once` });
    }
  }
  return problems;
}

// SPEC 9 and 13 (references.*): mime type, size, video duration and the number of files per request.
// Collects every problem so the app can mark each slot, then throws validation_failed.
export function validateUploadFiles(files: readonly UploadFileRequest[], limits: ReferencesConfig): ValidatedUpload[] {
  const problems: UploadProblem[] = [];
  const accepted: ValidatedUpload[] = [];
  const seen = new Set<string>();

  for (const file of files) {
    if (seen.has(file.clientId)) {
      problems.push({ clientId: file.clientId, code: 'duplicate_client_id', message: 'clientId must be unique in a request' });
      continue;
    }
    seen.add(file.clientId);

    const mimeType = file.mimeType.toLowerCase();
    const mediaType = mediaTypeOf(mimeType, limits);
    if (mediaType === null) {
      problems.push({ clientId: file.clientId, code: 'unsupported_mime_type', message: `${file.mimeType} is not an accepted type` });
      continue;
    }
    const fileProblems = checkFile(file, mediaType, limits);
    problems.push(...fileProblems);
    if (fileProblems.length === 0) accepted.push({ file, mediaType, mimeType });
  }
  problems.push(...checkCounts(files, limits));

  if (problems.length > 0) throw AppError.validation('Some files cannot be uploaded', { files: problems });
  return accepted;
}
