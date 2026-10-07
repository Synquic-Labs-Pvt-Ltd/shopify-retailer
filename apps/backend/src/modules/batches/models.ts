import mongoose, { Schema, type Types } from 'mongoose';
import {
  BATCH_STATUSES,
  ITEM_STATUSES,
  PLAN_SOURCES,
  REFERENCE_MODES,
  type BatchConfigSnapshot,
  type BatchCounts,
  type BatchStatus,
  type CreativePlan,
  type ItemStatus,
  type PlanSource,
  type ProductSnapshot,
  type ReferenceMode,
} from '@rs/shared';

// SPEC 14.7. Extras: coverImageUrl (the first product's image, saved at creation so lists need no join) and
// the stats stamps. statsSeq hands out a ticket per recount; statsApplied is the ticket of the last write.
export interface BatchDoc {
  _id: Types.ObjectId;
  shopId: Types.ObjectId;
  createdByUserId: Types.ObjectId;
  idempotencyKey: string;
  status: BatchStatus;
  configSnapshot: BatchConfigSnapshot;
  commonReferenceMediaIds: Types.ObjectId[];
  coverImageUrl: string | null;
  counts: BatchCounts;
  cancelRequestedAt?: Date | null;
  startedAt?: Date | null;
  finishedAt?: Date | null;
  statsSeq: number;
  statsApplied: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface ItemCountsDoc {
  jobsTotal: number;
  succeeded: number;
  failed: number;
  cancelled: number;
}

// SPEC 14.8, plus statsApplied (see BatchDoc).
export interface BatchItemDoc {
  _id: Types.ObjectId;
  batchId: Types.ObjectId;
  shopId: Types.ObjectId;
  productGid: string;
  productSnapshot: ProductSnapshot;
  ownReferenceMediaIds: Types.ObjectId[];
  effectiveReferenceMediaIds: Types.ObjectId[];
  referenceMode: ReferenceMode;
  status: ItemStatus;
  creativePlan?: CreativePlan | null;
  planSource?: PlanSource | null;
  outputMediaIds: Types.ObjectId[];
  counts: ItemCountsDoc;
  finishedAt?: Date | null;
  statsApplied: number;
  createdAt: Date;
  updatedAt: Date;
}

const objectId = Schema.Types.ObjectId;
const number0 = { type: Number, default: 0 };

const batchSchema = new Schema<BatchDoc>(
  {
    shopId: { type: objectId, required: true },
    createdByUserId: { type: objectId, required: true },
    idempotencyKey: { type: String, required: true },
    status: { type: String, enum: BATCH_STATUSES, required: true },
    configSnapshot: { type: Schema.Types.Mixed, required: true },
    commonReferenceMediaIds: { type: [objectId], default: [] },
    coverImageUrl: { type: String, default: null },
    counts: {
      products: number0,
      jobsTotal: number0,
      jobsSucceeded: number0,
      jobsFailed: number0,
      jobsCancelled: number0,
      imagesReady: number0,
      videosReady: number0,
    },
    cancelRequestedAt: { type: Date },
    startedAt: { type: Date },
    finishedAt: { type: Date },
    statsSeq: number0,
    statsApplied: number0,
  },
  { collection: 'batches', timestamps: true },
);

batchSchema.index({ shopId: 1, idempotencyKey: 1 }, { unique: true });
batchSchema.index({ shopId: 1, createdAt: -1 });
batchSchema.index({ shopId: 1, status: 1 });

const itemSchema = new Schema<BatchItemDoc>(
  {
    batchId: { type: objectId, required: true },
    shopId: { type: objectId, required: true, index: true },
    productGid: { type: String, required: true },
    productSnapshot: { type: Schema.Types.Mixed, required: true },
    ownReferenceMediaIds: { type: [objectId], default: [] },
    effectiveReferenceMediaIds: { type: [objectId], default: [] },
    referenceMode: { type: String, enum: REFERENCE_MODES, required: true },
    status: { type: String, enum: ITEM_STATUSES, required: true },
    creativePlan: { type: Schema.Types.Mixed, default: null },
    planSource: { type: String, enum: PLAN_SOURCES },
    outputMediaIds: { type: [objectId], default: [] },
    counts: {
      jobsTotal: number0,
      succeeded: number0,
      failed: number0,
      cancelled: number0,
    },
    finishedAt: { type: Date },
    statsApplied: number0,
  },
  { collection: 'batch_items', timestamps: true },
);

itemSchema.index({ batchId: 1 });
itemSchema.index({ batchId: 1, productGid: 1 }, { unique: true });

export const BatchModel = mongoose.model<BatchDoc>('Batch', batchSchema);
export const BatchItemModel = mongoose.model<BatchItemDoc>('BatchItem', itemSchema);
