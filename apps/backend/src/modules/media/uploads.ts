import { Types } from 'mongoose';
import type { MediaObject, UploadFileRequest, UploadTarget } from '@rs/shared';
import { AppError } from '../../core/errors';
import type { DriverDeps } from './deps';
import { failedUpdate } from './file-updates';
import { createFile, stageUploads } from './files-api';
import { validateUploadFiles } from './limits';
import { toMediaObject, toObjectId } from './mapper';
import { MediaAssetModel } from './models';
import { referenceFilename } from './naming';
import type { MediaActor } from './index';

const REFERENCE_ALT = 'Retailer Studio reference';

// Reference upload steps 2 to 4 (SPEC 8.6): validate, stage, then record. The records are written
// only after Shopify answered, so a Shopify failure leaves no orphans behind.
export async function createUploadTargets(deps: DriverDeps, actor: MediaActor, files: UploadFileRequest[]): Promise<UploadTarget[]> {
  const accepted = validateUploadFiles(files, deps.getConfig().references);
  const planned = accepted.map((item) => ({ ...item, id: new Types.ObjectId(), filename: referenceFilename(item.mimeType) }));

  const staged = await stageUploads(
    deps.admin,
    actor.shopId,
    planned.map((item) => ({ filename: item.filename, mimeType: item.mimeType, mediaType: item.mediaType, fileSize: item.file.fileSize })),
  );

  await MediaAssetModel.insertMany(
    planned.map((item, index) => ({
      _id: item.id,
      shopId: new Types.ObjectId(actor.shopId),
      createdByUserId: new Types.ObjectId(actor.userId),
      role: 'reference',
      mediaType: item.mediaType,
      storageProvider: 'shopify',
      status: 'awaiting_upload',
      filename: item.filename,
      mimeType: item.mimeType,
      fileSize: item.file.fileSize,
      shopify: { stagedResourceUrl: staged[index]?.resourceUrl },
      alt: REFERENCE_ALT,
      scope: item.file.scope,
      ...(item.file.productGid === undefined ? {} : { productGid: item.file.productGid }),
      ...(item.file.durationSec === undefined || item.mediaType === 'image' ? {} : { durationSec: item.file.durationSec }),
    })),
  );

  return planned.map((item, index) => {
    const target = staged[index];
    if (target === undefined) throw AppError.internal('Missing staged target');
    return { clientId: item.file.clientId, mediaId: item.id.toHexString(), url: target.url, method: 'POST', parameters: target.parameters };
  });
}

// Reference upload step 6: fileCreate with the staged resourceUrl, then status processing. Calling it
// again for an asset that is already past awaiting_upload returns the asset unchanged.
export async function completeUpload(deps: DriverDeps, actor: MediaActor, mediaId: string): Promise<MediaObject> {
  const id = toObjectId(mediaId);
  if (id === null) throw AppError.notFound('Media not found');
  const shopId = new Types.ObjectId(actor.shopId);
  const scope = { _id: id, shopId, role: 'reference' as const };

  // The claim makes sure only one request calls fileCreate for this asset.
  const claimed = await MediaAssetModel.findOneAndUpdate(
    { ...scope, status: 'awaiting_upload' },
    { $set: { status: 'processing' } },
    { returnDocument: 'after' },
  ).lean();
  if (claimed === null) {
    const existing = await MediaAssetModel.findOne(scope).lean();
    if (existing === null || existing.status === 'deleted') throw AppError.notFound('Media not found');
    return toMediaObject(existing);
  }

  const stagedResourceUrl = claimed.shopify?.stagedResourceUrl;
  if (stagedResourceUrl === undefined) throw AppError.internal('Media has no staged upload');

  let created;
  try {
    created = await createFile(deps.admin, actor.shopId, {
      originalSource: stagedResourceUrl,
      mediaType: claimed.mediaType,
      filename: claimed.filename,
      alt: claimed.alt ?? REFERENCE_ALT,
    });
  } catch (err) {
    // Not the file's fault (network, throttling): let the app call complete again.
    await MediaAssetModel.updateOne({ _id: id, status: 'processing' }, { $set: { status: 'awaiting_upload' } });
    throw err;
  }

  const update = created.ok
    ? { $set: { 'shopify.fileGid': created.fileGid } }
    : failedUpdate({ code: created.code, message: created.message });
  if (!created.ok) deps.logger.warn({ mediaId, code: created.code }, 'fileCreate rejected the upload');
  const updated = await MediaAssetModel.findByIdAndUpdate(id, update, { returnDocument: 'after' }).lean();
  if (updated === null) throw AppError.notFound('Media not found');
  return toMediaObject(updated);
}
