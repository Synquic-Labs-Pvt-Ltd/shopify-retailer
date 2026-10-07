import { Schema, model, type Types } from 'mongoose';
import { OAUTH_PHASES, SESSION_PLATFORMS, type OauthPhase, type SessionPlatform } from '@rs/shared';

export interface UserDoc {
  _id: Types.ObjectId;
  shopId: Types.ObjectId;
  shopifyUserId: string;
  email?: string | null;
  firstName?: string | null;
  lastName?: string | null;
  locale?: string | null;
  accountOwner?: boolean;
  collaborator?: boolean;
  lastLoginAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

const userSchema = new Schema<UserDoc>(
  {
    shopId: { type: Schema.Types.ObjectId, required: true },
    shopifyUserId: { type: String, required: true },
    email: String,
    firstName: String,
    lastName: String,
    locale: String,
    accountOwner: Boolean,
    collaborator: Boolean,
    lastLoginAt: Date,
  },
  { timestamps: true, collection: 'users' },
);
userSchema.index({ shopId: 1, shopifyUserId: 1 }, { unique: true });

export interface SessionDoc {
  _id: Types.ObjectId;
  userId: Types.ObjectId;
  shopId: Types.ObjectId;
  refreshTokenHash: string;
  // Shared by every session of one rotation chain; reuse of a rotated token revokes the whole family.
  familyId: string;
  platform?: SessionPlatform;
  deviceName?: string;
  lastUsedAt?: Date;
  expiresAt: Date;
  revokedAt?: Date | null;
  replacedBySessionId?: Types.ObjectId | null;
  createdAt: Date;
  updatedAt: Date;
}

const sessionSchema = new Schema<SessionDoc>(
  {
    userId: { type: Schema.Types.ObjectId, required: true },
    shopId: { type: Schema.Types.ObjectId, required: true },
    refreshTokenHash: { type: String, required: true, unique: true },
    familyId: { type: String, required: true, index: true },
    platform: { type: String, enum: SESSION_PLATFORMS },
    deviceName: String,
    lastUsedAt: Date,
    expiresAt: { type: Date, required: true },
    revokedAt: Date,
    replacedBySessionId: Schema.Types.ObjectId,
  },
  { timestamps: true, collection: 'sessions' },
);
sessionSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
sessionSchema.index({ shopId: 1 });

export interface OAuthStateDoc {
  _id: Types.ObjectId;
  nonce: string;
  shopDomain: string;
  phase: OauthPhase;
  // Null when the flow was started from the app URL landing page (no mobile app is waiting).
  codeChallenge?: string | null;
  consumedAt?: Date | null;
  expiresAt: Date;
  createdAt: Date;
  updatedAt: Date;
}

const oauthStateSchema = new Schema<OAuthStateDoc>(
  {
    nonce: { type: String, required: true, unique: true },
    shopDomain: { type: String, required: true },
    phase: { type: String, enum: OAUTH_PHASES, required: true },
    codeChallenge: String,
    consumedAt: Date,
    expiresAt: { type: Date, required: true },
  },
  { timestamps: true, collection: 'oauth_states' },
);
oauthStateSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export interface LoginCodeDoc {
  _id: Types.ObjectId;
  codeHash: string;
  userId: Types.ObjectId;
  shopId: Types.ObjectId;
  codeChallenge: string;
  consumedAt?: Date | null;
  expiresAt: Date;
  createdAt: Date;
  updatedAt: Date;
}

const loginCodeSchema = new Schema<LoginCodeDoc>(
  {
    codeHash: { type: String, required: true, unique: true },
    userId: { type: Schema.Types.ObjectId, required: true },
    shopId: { type: Schema.Types.ObjectId, required: true, index: true },
    codeChallenge: { type: String, required: true },
    consumedAt: Date,
    expiresAt: { type: Date, required: true },
  },
  { timestamps: true, collection: 'login_codes' },
);
loginCodeSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export const UserModel = model<UserDoc>('users', userSchema);
export const SessionModel = model<SessionDoc>('sessions', sessionSchema);
export const OAuthStateModel = model<OAuthStateDoc>('oauth_states', oauthStateSchema);
export const LoginCodeModel = model<LoginCodeDoc>('login_codes', loginCodeSchema);
