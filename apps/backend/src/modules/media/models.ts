import mongoose, { Schema, type Types } from 'mongoose';
import {
  MEDIA_ROLES,
  MEDIA_SCOPES,
  MEDIA_STATUSES,
  MEDIA_TYPES,
  STORAGE_PROVIDERS,
  type MediaRole,
  type MediaScope,
  type MediaStatus,
  type MediaType,
  type StorageProvider,
} from '@rs/shared';

// SPEC 14.6. Optional fields are left out of the document until they are known (never stored as
// null), which keeps the sparse unique indexes on shopify.fileGid and sourceJobId correct.
export interface MediaAssetDoc {
  _id: Types.ObjectId;
  shopId: Types.ObjectId;
  createdByUserId?: Types.ObjectId;
  role: MediaRole;
  mediaType: MediaType;
  storageProvider: StorageProvider;
  status: MediaStatus;
  filename: string;
  mimeType: string;
  fileSize: number;
  shopify?: { fileGid?: string; stagedResourceUrl?: string; lastCheckedAt?: Date };
  url?: string;
  previewUrl?: string;
  width?: number;
  height?: number;
  durationSec?: number;
  alt?: string;
  scope?: MediaScope;
  productGid?: string;
  batchId?: Types.ObjectId;
  batchItemId?: Types.ObjectId;
  sourceJobId?: Types.ObjectId;
  shotTitle?: string;
  error?: { code?: string; message?: string };
  readyAt?: Date;
  deletedAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

const objectId = Schema.Types.ObjectId;

const mediaAssetSchema = new Schema<MediaAssetDoc>(
  {
    shopId: { type: objectId, required: true },
    createdByUserId: { type: objectId },
    role: { type: String, enum: MEDIA_ROLES, required: true },
    mediaType: { type: String, enum: MEDIA_TYPES, required: true },
    storageProvider: { type: String, enum: STORAGE_PROVIDERS, default: 'shopify' },
    status: { type: String, enum: MEDIA_STATUSES, required: true },
    filename: { type: String, required: true },
    mimeType: { type: String, required: true },
    fileSize: { type: Number, required: true },
    shopify: {
      fileGid: { type: String },
      stagedResourceUrl: { type: String },
      lastCheckedAt: { type: Date },
    },
    url: { type: String },
    previewUrl: { type: String },
    width: { type: Number },
    height: { type: Number },
    durationSec: { type: Number },
    alt: { type: String },
    scope: { type: String, enum: MEDIA_SCOPES },
    productGid: { type: String },
    batchId: { type: objectId },
    batchItemId: { type: objectId },
    sourceJobId: { type: objectId },
    shotTitle: { type: String },
    error: { code: { type: String }, message: { type: String } },
    readyAt: { type: Date },
    deletedAt: { type: Date },
  },
  { collection: 'media_assets', timestamps: true },
);

mediaAssetSchema.index({ shopId: 1, role: 1, createdAt: -1 });
mediaAssetSchema.index({ shopId: 1, status: 1 });
mediaAssetSchema.index({ 'shopify.fileGid': 1 }, { unique: true, sparse: true });
mediaAssetSchema.index({ sourceJobId: 1 }, { unique: true, sparse: true });
mediaAssetSchema.index({ batchItemId: 1 });

export const MediaAssetModel = mongoose.model<MediaAssetDoc>('MediaAsset', mediaAssetSchema);
