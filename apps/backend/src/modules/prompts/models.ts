import mongoose, { Schema, type Types } from 'mongoose';
import { PROMPT_NAMES, type PromptName } from '@rs/shared';

// A saved version of one prompt of one store. Versions are immutable: an edit is a new document, so a batch that
// froze version 3 reads the same text for as long as it lives. Version 0 is the global default and has no document.
export interface PromptVersionDoc {
  _id: Types.ObjectId;
  shopId: Types.ObjectId;
  name: PromptName;
  version: number;
  text: string;
  // Length of the text, kept so the history lists without loading the texts.
  chars: number;
  // First 12 hex characters of the SHA-256 of the text.
  hash: string;
  note?: string;
  createdByUserId?: Types.ObjectId;
  createdAt: Date;
}

// Which version a store uses for a prompt, and the highest number it has handed out.
export interface PromptStateDoc {
  _id: Types.ObjectId;
  shopId: Types.ObjectId;
  name: PromptName;
  // 0 is the global default.
  activeVersion: number;
  latestVersion: number;
  updatedAt: Date;
}

const objectId = Schema.Types.ObjectId;

const versionSchema = new Schema<PromptVersionDoc>(
  {
    shopId: { type: objectId, required: true },
    name: { type: String, enum: PROMPT_NAMES, required: true },
    version: { type: Number, required: true },
    text: { type: String, required: true },
    chars: { type: Number, required: true },
    hash: { type: String, required: true },
    note: { type: String },
    createdByUserId: { type: objectId },
    createdAt: { type: Date, required: true },
  },
  { collection: 'prompt_versions' },
);
versionSchema.index({ shopId: 1, name: 1, version: 1 }, { unique: true });

const stateSchema = new Schema<PromptStateDoc>(
  {
    shopId: { type: objectId, required: true },
    name: { type: String, enum: PROMPT_NAMES, required: true },
    activeVersion: { type: Number, required: true, default: 0 },
    latestVersion: { type: Number, required: true, default: 0 },
    updatedAt: { type: Date, required: true },
  },
  { collection: 'prompt_states' },
);
stateSchema.index({ shopId: 1, name: 1 }, { unique: true });

export const PromptVersionModel =
  (mongoose.models.PromptVersion as mongoose.Model<PromptVersionDoc> | undefined) ??
  mongoose.model<PromptVersionDoc>('PromptVersion', versionSchema);

export const PromptStateModel =
  (mongoose.models.PromptState as mongoose.Model<PromptStateDoc> | undefined) ??
  mongoose.model<PromptStateDoc>('PromptState', stateSchema);
