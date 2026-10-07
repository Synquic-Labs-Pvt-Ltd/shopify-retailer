import { Types } from 'mongoose';
import type { MediaObject } from '@rs/shared';
import type { MediaAssetRecord } from './index';
import type { MediaAssetDoc } from './models';

const OBJECT_ID_HEX = /^[a-f0-9]{24}$/;

// Client and caller ids are checked before they reach a query, so a malformed id is "not found"
// and never a cast error.
export function toObjectId(id: string): Types.ObjectId | null {
  return OBJECT_ID_HEX.test(id) ? new Types.ObjectId(id) : null;
}

export function toObjectIds(ids: readonly string[]): Types.ObjectId[] {
  return [...new Set(ids)].flatMap((id) => {
    const objectId = toObjectId(id);
    return objectId === null ? [] : [objectId];
  });
}

export function toMediaObject(doc: MediaAssetDoc): MediaObject {
  return {
    id: doc._id.toHexString(),
    role: doc.role,
    mediaType: doc.mediaType,
    status: doc.status,
    url: doc.url ?? null,
    previewUrl: doc.previewUrl ?? null,
    width: doc.width ?? null,
    height: doc.height ?? null,
    durationSec: doc.durationSec ?? null,
    filename: doc.filename,
    scope: doc.scope ?? null,
    productGid: doc.productGid ?? null,
    shotTitle: doc.shotTitle ?? null,
    createdAt: doc.createdAt.toISOString(),
  };
}

export function toAssetRecord(doc: MediaAssetDoc): MediaAssetRecord {
  return {
    id: doc._id.toHexString(),
    shopId: doc.shopId.toHexString(),
    role: doc.role,
    mediaType: doc.mediaType,
    status: doc.status,
    filename: doc.filename,
    mimeType: doc.mimeType,
    fileSize: doc.fileSize,
    url: doc.url ?? null,
    previewUrl: doc.previewUrl ?? null,
    width: doc.width ?? null,
    height: doc.height ?? null,
    durationSec: doc.durationSec ?? null,
    scope: doc.scope ?? null,
    productGid: doc.productGid ?? null,
    batchId: doc.batchId?.toHexString() ?? null,
    batchItemId: doc.batchItemId?.toHexString() ?? null,
    shotTitle: doc.shotTitle ?? null,
    createdAt: doc.createdAt,
  };
}

// Keeps the order of the requested ids and drops the ones that were not found.
export function inRequestedOrder(ids: readonly string[], docs: readonly MediaAssetDoc[]): MediaAssetDoc[] {
  const byId = new Map(docs.map((doc) => [doc._id.toHexString(), doc]));
  return [...new Set(ids)].flatMap((id) => {
    const doc = byId.get(id);
    return doc === undefined ? [] : [doc];
  });
}
