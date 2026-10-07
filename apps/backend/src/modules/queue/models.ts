import mongoose, { Schema, type Types } from 'mongoose';
import { JOB_ERROR_CODES, JOB_STATUSES, JOB_TYPES, type JobErrorCode, type JobStatus, type JobType } from '@rs/shared';

// SPEC 14.9, plus requeuedAt: set by requeueFailed so the quota_timeout age is measured from the retry
// and not from a batch that may be days old.
export interface JobDoc {
  _id: Types.ObjectId;
  shopId: Types.ObjectId;
  batchId: Types.ObjectId;
  batchItemId: Types.ObjectId;
  type: JobType;
  lane: string;
  status: JobStatus;
  dependsOn: Types.ObjectId[];
  outputIndex?: number | null;
  priority: number;
  runAt: Date;
  attempts: number;
  maxAttempts: number;
  deferrals: number;
  lease?: { owner?: string; expiresAt?: Date };
  operation?: { name?: string; submittedAt?: Date; nextPollAt?: Date; polls?: number };
  promptVersion?: string;
  renderedPrompt?: string;
  output?: { mediaAssetId?: Types.ObjectId | null; providerResponseId?: string | null; modelVersion?: string | null };
  error?: {
    code?: JobErrorCode;
    message?: string;
    providerReason?: string;
    httpStatus?: number;
    retryable?: boolean;
    at?: Date;
  };
  startedAt?: Date;
  finishedAt?: Date;
  requeuedAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

const objectId = Schema.Types.ObjectId;

const jobSchema = new Schema<JobDoc>(
  {
    shopId: { type: objectId, required: true },
    batchId: { type: objectId, required: true },
    batchItemId: { type: objectId, required: true },
    type: { type: String, enum: JOB_TYPES, required: true },
    lane: { type: String, required: true },
    status: { type: String, enum: JOB_STATUSES, required: true },
    dependsOn: { type: [objectId], default: [] },
    outputIndex: { type: Number },
    priority: { type: Number, default: 0 },
    runAt: { type: Date, required: true },
    attempts: { type: Number, default: 0 },
    maxAttempts: { type: Number, required: true },
    deferrals: { type: Number, default: 0 },
    lease: { owner: { type: String }, expiresAt: { type: Date } },
    operation: {
      name: { type: String },
      submittedAt: { type: Date },
      nextPollAt: { type: Date },
      polls: { type: Number },
    },
    promptVersion: { type: String },
    renderedPrompt: { type: String },
    output: {
      mediaAssetId: { type: objectId },
      providerResponseId: { type: String },
      modelVersion: { type: String },
    },
    error: {
      code: { type: String, enum: JOB_ERROR_CODES },
      message: { type: String },
      providerReason: { type: String },
      httpStatus: { type: Number },
      retryable: { type: Boolean },
      at: { type: Date },
    },
    startedAt: { type: Date },
    finishedAt: { type: Date },
    requeuedAt: { type: Date },
  },
  { collection: 'jobs', timestamps: true },
);

jobSchema.index({ status: 1, lane: 1, runAt: 1, priority: -1 });
jobSchema.index({ status: 1, 'operation.nextPollAt': 1 });
jobSchema.index({ status: 1, 'lease.expiresAt': 1 });
jobSchema.index({ batchId: 1 });
jobSchema.index({ batchItemId: 1 });
jobSchema.index({ shopId: 1, createdAt: 1 });

export const JobModel = mongoose.model<JobDoc>('Job', jobSchema);
