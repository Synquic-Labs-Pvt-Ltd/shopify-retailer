import { Types } from 'mongoose';
import type { MediaObject } from '@rs/shared';
import type { DriverDeps } from './deps';
import { describeError, StorageUploadError } from './errors';
import { failedUpdate, readyUpdate } from './file-updates';
import { createFile, queryFileStates, stageUploads, type StagedTarget } from './files-api';
import { toMediaObject } from './mapper';
import { MediaAssetModel, type MediaAssetDoc } from './models';
import type { PersistOutputInput } from './index';

// SPEC 8.6: poll fileStatus every 3 seconds, up to 2 minutes for images and 10 minutes for videos.
export const POLL_INTERVAL_MS = 3_000;
export const IMAGE_READY_TIMEOUT_MS = 2 * 60_000;
export const VIDEO_READY_TIMEOUT_MS = 10 * 60_000;
// A single failed status query does not end a poll that may be waiting on an expensive output.
const MAX_CONSECUTIVE_POLL_ERRORS = 3;
const IMAGE_POST_TIMEOUT_MS = 60_000;
const VIDEO_POST_TIMEOUT_MS = 5 * 60_000;
const ERROR_BODY_SNIPPET_CHARS = 300;

function isDuplicateKey(err: unknown): boolean {
  return typeof err === 'object' && err !== null && 'code' in err && err.code === 11000;
}

async function findOrCreateRecord(input: PersistOutputInput, shopId: Types.ObjectId, sourceJobId: Types.ObjectId): Promise<MediaAssetDoc> {
  const existing = await MediaAssetModel.findOne({ shopId, sourceJobId }).lean<MediaAssetDoc>();
  if (existing !== null) return existing;
  try {
    return await MediaAssetModel.create({
      shopId,
      sourceJobId,
      createdByUserId: new Types.ObjectId(input.createdByUserId),
      role: 'output',
      mediaType: input.mediaType,
      storageProvider: 'shopify',
      status: 'awaiting_upload',
      filename: input.filename,
      mimeType: input.mimeType,
      fileSize: input.bytes.byteLength,
      alt: input.alt,
      productGid: input.productGid,
      batchId: new Types.ObjectId(input.batchId),
      batchItemId: new Types.ObjectId(input.batchItemId),
      shotTitle: input.shotTitle,
    }).then((doc) => doc.toObject());
  } catch (err) {
    // Another worker created the record between the read and the insert.
    if (!isDuplicateKey(err)) throw err;
    const raced = await MediaAssetModel.findOne({ shopId, sourceJobId }).lean<MediaAssetDoc>();
    if (raced === null) throw err;
    return raced;
  }
}

// Server side multipart POST: every staged parameter first, the file last (SPEC 8.6).
async function postToStagedTarget(deps: DriverDeps, target: StagedTarget, input: PersistOutputInput): Promise<void> {
  const form = new FormData();
  for (const parameter of target.parameters) form.append(parameter.name, parameter.value);
  form.append('file', new Blob([new Uint8Array(input.bytes)], { type: input.mimeType }), input.filename);

  const timeoutMs = input.mediaType === 'video' ? VIDEO_POST_TIMEOUT_MS : IMAGE_POST_TIMEOUT_MS;
  const response = await deps.fetchImpl(target.url, { method: 'POST', body: form, signal: AbortSignal.timeout(timeoutMs) });
  if (!response.ok) {
    const body = (await response.text().catch(() => '')).slice(0, ERROR_BODY_SNIPPET_CHARS);
    throw new StorageUploadError(`The staged upload was rejected with HTTP ${response.status}: ${body}`, response.status >= 500 || response.status === 429);
  }
}

// Steps stagedUploadsCreate, POST and fileCreate. Returns the asset with its fileGid, status processing.
async function uploadBytes(deps: DriverDeps, input: PersistOutputInput, asset: MediaAssetDoc): Promise<MediaAssetDoc> {
  const [target] = await stageUploads(deps.admin, input.shopId, [
    { filename: input.filename, mimeType: input.mimeType, mediaType: input.mediaType, fileSize: input.bytes.byteLength },
  ]);
  if (target === undefined) throw new StorageUploadError('Shopify returned no staged target', true);
  await postToStagedTarget(deps, target, input);

  const created = await createFile(deps.admin, input.shopId, {
    originalSource: target.resourceUrl,
    mediaType: input.mediaType,
    filename: input.filename,
    alt: input.alt,
  });
  if (!created.ok) {
    await MediaAssetModel.updateOne({ _id: asset._id }, failedUpdate(created));
    throw new StorageUploadError(`Shopify rejected the file: ${created.message}`, false);
  }
  const updated = await MediaAssetModel.findByIdAndUpdate(
    asset._id,
    {
      $set: { status: 'processing', 'shopify.fileGid': created.fileGid, 'shopify.stagedResourceUrl': target.resourceUrl },
      $unset: { error: 1 },
    },
    { returnDocument: 'after' },
  ).lean<MediaAssetDoc>();
  if (updated === null) throw new StorageUploadError('The media record disappeared during the upload', false);
  return updated;
}

async function waitUntilReady(deps: DriverDeps, asset: MediaAssetDoc, shopId: string): Promise<MediaObject> {
  const fileGid = asset.shopify?.fileGid;
  if (fileGid === undefined) throw new StorageUploadError('The media record has no Shopify file', false);
  const timeoutMs = asset.mediaType === 'video' ? VIDEO_READY_TIMEOUT_MS : IMAGE_READY_TIMEOUT_MS;
  const deadline = deps.now().getTime() + timeoutMs;
  let consecutiveErrors = 0;

  for (;;) {
    await deps.sleep(POLL_INTERVAL_MS);
    try {
      const state = (await queryFileStates(deps.admin, shopId, [{ fileGid, mediaType: asset.mediaType }])).get(fileGid);
      consecutiveErrors = 0;
      if (state?.status === 'ready') {
        const ready = await MediaAssetModel.findByIdAndUpdate(asset._id, readyUpdate(state, deps.now()), { returnDocument: 'after' }).lean<MediaAssetDoc>();
        if (ready === null) throw new StorageUploadError('The media record disappeared during the upload', false);
        return toMediaObject(ready);
      }
      if (state?.status === 'failed') {
        await MediaAssetModel.updateOne({ _id: asset._id }, failedUpdate(state));
        throw new StorageUploadError(`Shopify could not process the file: ${state.message}`, true);
      }
    } catch (err) {
      if (err instanceof StorageUploadError) throw err;
      consecutiveErrors += 1;
      deps.logger.warn({ fileGid, error: describeError(err), consecutiveErrors }, 'fileStatus poll failed');
      if (consecutiveErrors >= MAX_CONSECUTIVE_POLL_ERRORS) throw err;
    }
    if (deps.now().getTime() >= deadline) {
      throw new StorageUploadError(`Timed out after ${timeoutMs / 1000} s waiting for Shopify to process the file`, true);
    }
  }
}

async function persist(deps: DriverDeps, input: PersistOutputInput): Promise<MediaObject> {
  const shopId = new Types.ObjectId(input.shopId);
  const sourceJobId = new Types.ObjectId(input.sourceJobId);
  const asset = await findOrCreateRecord(input, shopId, sourceJobId);

  if (asset.status === 'ready') return toMediaObject(asset);
  // An earlier attempt uploaded the file but stopped waiting: pick up the polling, do not upload again.
  const uploaded = asset.status === 'processing' && asset.shopify?.fileGid !== undefined ? asset : await uploadBytes(deps, input, asset);
  return waitUntilReady(deps, uploaded, input.shopId);
}

// Idempotent per sourceJobId (SPEC 8.6): a ready output is returned as is, a half-finished one is
// resumed. Every failure is reported as a StorageUploadError.
export async function persistOutput(deps: DriverDeps, input: PersistOutputInput): Promise<MediaObject> {
  try {
    return await persist(deps, input);
  } catch (err) {
    if (err instanceof StorageUploadError) throw err;
    throw new StorageUploadError(`Storing the output failed: ${describeError(err)}`, true, err);
  }
}
