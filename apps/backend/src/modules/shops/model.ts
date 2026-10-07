import { Schema, model, type Types } from 'mongoose';
import { SHOP_STATUSES, isValidShopDomain, type ShopStatus } from '@rs/shared';

// Secrets carry the "Enc" suffix: AES-256-GCM, base64 iv:tag:cipher (SPEC 14.1).
export interface OfflineTokenFields {
  accessTokenEnc?: string | null;
  accessTokenExpiresAt?: Date | null;
  refreshTokenEnc?: string | null;
  refreshTokenExpiresAt?: Date | null;
  refreshLockUntil?: Date | null;
}

export interface ShopDoc {
  _id: Types.ObjectId;
  shopDomain: string;
  shopGid?: string | null;
  name?: string | null;
  email?: string | null;
  currencyCode?: string | null;
  ianaTimezone?: string | null;
  status: ShopStatus;
  scopes: string[];
  offlineToken?: OfflineTokenFields | null;
  installedAt?: Date | null;
  uninstalledAt?: Date | null;
  redactAfter?: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

const shopSchema = new Schema<ShopDoc>(
  {
    shopDomain: {
      type: String,
      required: true,
      unique: true,
      lowercase: true,
      trim: true,
      validate: { validator: isValidShopDomain, message: 'Invalid Shopify store domain' },
    },
    shopGid: String,
    name: String,
    email: String,
    currencyCode: String,
    ianaTimezone: String,
    status: { type: String, enum: SHOP_STATUSES, required: true },
    scopes: { type: [String], default: [] },
    offlineToken: {
      accessTokenEnc: String,
      accessTokenExpiresAt: Date,
      refreshTokenEnc: String,
      refreshTokenExpiresAt: Date,
      refreshLockUntil: Date,
    },
    installedAt: Date,
    uninstalledAt: Date,
    redactAfter: Date,
  },
  { timestamps: true, collection: 'shops' },
);

shopSchema.index({ status: 1 });

export const ShopModel = model<ShopDoc>('shops', shopSchema);
