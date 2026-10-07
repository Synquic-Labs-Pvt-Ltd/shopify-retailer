import type { ShopStatus } from '@rs/shared';
import type { Env } from '../../core/env';
import type { Logger } from '../../core/logger';
import { createShopsService } from './service';

export { parseScopes, scopesSatisfy } from './scopes';

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

// Token endpoint response for an authorization-code exchange (offline phase).
export interface OAuthTokenGrant {
  shopDomain: string;
  accessToken: string;
  // Null for a non-expiring token (no refresh token was issued).
  refreshToken: string | null;
  expiresInSeconds: number | null;
  refreshTokenExpiresInSeconds: number | null;
  // Comma-separated, exactly as Shopify returns it.
  scope: string;
}

export interface ShopInfo {
  shopGid: string | null;
  name: string | null;
  email: string | null;
  currencyCode: string | null;
  ianaTimezone: string | null;
}

// What the auth and shopify modules need beyond the public ShopsService.
export interface ShopsInternalService extends ShopsService {
  // Offline phase of the OAuth callback: upserts the shop (status active) and replaces its tokens.
  upsertFromOAuth(grant: OAuthTokenGrant): Promise<ShopRecord>;
  saveShopInfo(shopId: string, info: ShopInfo): Promise<ShopRecord | null>;
  // The stored token is rejected by Shopify: status reauth_required and tokens wiped.
  markReauthRequired(shopId: string): Promise<void>;
}

export interface ShopsDeps {
  env: Pick<Env, 'SHOPIFY_API_KEY' | 'SHOPIFY_API_SECRET' | 'TOKEN_ENC_KEY'>;
  logger: Logger;
  fetchImpl?: typeof fetch;
  now?: () => Date;
  // How long one refresh may hold the per-shop lock. Default 60 s.
  refreshLockMs?: number;
  // How often losers re-read while another instance refreshes. Default 100 ms.
  lockPollMs?: number;
}

export interface ShopsModule {
  service: ShopsInternalService;
}

export function createShopsModule(deps: ShopsDeps): ShopsModule {
  return { service: createShopsService(deps) };
}
