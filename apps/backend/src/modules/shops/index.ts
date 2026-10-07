import type { ShopStatus } from '@rs/shared';

export interface ShopRecord {
  id: string;
  shopDomain: string;
  shopGid: string | null;
  name: string | null;
  email: string | null;
  currencyCode: string | null;
  ianaTimezone: string | null;
  status: ShopStatus;
  scopes: string[];
}

export interface ShopsService {
  getById(shopId: string): Promise<ShopRecord | null>;
  getByDomain(shopDomain: string): Promise<ShopRecord | null>;
  // Throws AppError shop_reauth_required when the shop is not active.
  requireActive(shopId: string): Promise<ShopRecord>;
  // A valid offline access token. Refreshes behind the per-shop lock when it expires within 5 minutes.
  getAccessToken(shopId: string): Promise<string>;
  // app/uninstalled: status uninstalled, tokens wiped, redactAfter set.
  markUninstalled(shopDomain: string): Promise<ShopRecord | null>;
  // shop/redact: deletes the shop document.
  purgeShop(shopId: string): Promise<void>;
}
