import type { OauthPhase, ShopifyCallbackQuery } from '@rs/shared';
import { isValidShopDomain, normalizeShopDomain } from '@rs/shared';
import { AppError } from '../../core/errors';
import type { Env } from '../../core/env';
import type { Logger } from '../../core/logger';
import { parseScopes, scopesSatisfy, type ShopRecord, type ShopsInternalService } from '../shops';
import { randomToken, sha256Hex } from './crypto';
import { verifyOAuthQueryHmac } from './hmac';
import { LoginCodeModel, UserModel, type OAuthStateDoc, type UserDoc } from './models';
import type { OAuthStateStore } from './oauth-state';
import type { ShopifyOAuthClient } from './shopify-oauth';

export const LOGIN_CODE_TTL_MS = 2 * 60_000;

export type AuthEnv = Pick<
  Env,
  | 'PUBLIC_BASE_URL'
  | 'JWT_SECRET'
  | 'SHOPIFY_API_KEY'
  | 'SHOPIFY_API_SECRET'
  | 'SHOPIFY_SCOPES'
  | 'SHOPIFY_API_VERSION'
  | 'APP_DEEP_LINK_SCHEME'
>;

export type CallbackResult =
  // 302 to the next OAuth phase or to the app deep link.
  | { kind: 'redirect'; location: string }
  // The offline phase of an install started from the landing page: no app is waiting, show the page.
  | { kind: 'installed'; shopDomain: string };

export interface OAuthFlow {
  // GET /auth/shopify/start. Returns the Shopify authorize URL.
  start(shopDomain: string, challenge: string): Promise<string>;
  // GET /. Returns the authorize URL to start the offline phase, or null when the shop is installed.
  landing(shopDomain: string): Promise<string | null>;
  // GET /auth/shopify/callback. rawQuery is the unparsed query string, used for the HMAC.
  callback(rawQuery: string, query: ShopifyCallbackQuery): Promise<CallbackResult>;
}

export interface OAuthFlowDeps {
  env: AuthEnv;
  logger: Logger;
  shops: ShopsInternalService;
  states: OAuthStateStore;
  shopify: ShopifyOAuthClient;
  now: () => Date;
}

// SPEC 8.3 step 1: lowercase, append .myshopify.com if missing, then validate. Throws validation_failed.
export function parseShopInput(input: string): string {
  const shopDomain = normalizeShopDomain(input);
  if (!isValidShopDomain(shopDomain)) throw AppError.validation('Invalid Shopify store domain');
  return shopDomain;
}

export function createOAuthFlow(deps: OAuthFlowDeps): OAuthFlow {
  const { env, logger, shops, states, shopify, now } = deps;
  const redirectUri = `${env.PUBLIC_BASE_URL}/auth/shopify/callback`;

  // Offline if the shop is unknown, uninstalled, needs re-login, or has fewer scopes than required.
  const needsOfflinePhase = (shop: ShopRecord | null): boolean =>
    shop === null || shop.status !== 'active' || !scopesSatisfy(shop.scopes, env.SHOPIFY_SCOPES);

  const authorizeUrl = (shopDomain: string, nonce: string, phase: OauthPhase): string => {
    const url = new URL(`https://${shopDomain}/admin/oauth/authorize`);
    url.searchParams.set('client_id', env.SHOPIFY_API_KEY);
    url.searchParams.set('scope', env.SHOPIFY_SCOPES.join(','));
    url.searchParams.set('redirect_uri', redirectUri);
    url.searchParams.set('state', nonce);
    return phase === 'online' ? `${url.toString()}&grant_options[]=per-user` : url.toString();
  };

  const deepLink = (params: Record<string, string>): string =>
    `${env.APP_DEEP_LINK_SCHEME}://auth?${new URLSearchParams(params).toString()}`;

  const completeOffline = async (state: OAuthStateDoc, code: string): Promise<CallbackResult> => {
    const token = await shopify.exchangeCode(state.shopDomain, code, { expiring: true });
    if (!scopesSatisfy(parseScopes(token.scope), env.SHOPIFY_SCOPES)) {
      throw AppError.forbidden('The required access scopes were not granted');
    }

    const shop = await shops.upsertFromOAuth({
      shopDomain: state.shopDomain,
      accessToken: token.access_token,
      refreshToken: token.refresh_token ?? null,
      expiresInSeconds: token.expires_in ?? null,
      refreshTokenExpiresInSeconds: token.refresh_token_expires_in ?? null,
      scope: token.scope,
    });
    const info = await shopify.fetchShopInfo(state.shopDomain, token.access_token);
    if (info !== null) await shops.saveShopInfo(shop.id, info);
    logger.info({ shopId: shop.id, shopDomain: shop.shopDomain }, 'shop installed or re-authorized');

    if (!state.codeChallenge) return { kind: 'installed', shopDomain: state.shopDomain };
    // Shopify skips consent for scopes that are already granted, so this hop is instant.
    const nonce = await states.create(state.shopDomain, 'online', state.codeChallenge);
    return { kind: 'redirect', location: authorizeUrl(state.shopDomain, nonce, 'online') };
  };

  const completeOnline = async (state: OAuthStateDoc, code: string): Promise<CallbackResult> => {
    if (!state.codeChallenge) throw AppError.forbidden('Invalid or expired state');
    // The online token is only used to learn who logged in; it is never stored.
    const token = await shopify.exchangeCode(state.shopDomain, code, { expiring: false });
    const associated = token.associated_user;
    if (associated === undefined) throw AppError.forbidden('Shopify did not return the signed-in user');

    const shop = await shops.getByDomain(state.shopDomain);
    if (shop === null || shop.status !== 'active') throw AppError.shopReauthRequired();

    const user = await UserModel.findOneAndUpdate(
      { shopId: shop.id, shopifyUserId: associated.id },
      {
        $set: {
          email: associated.email ?? null,
          firstName: associated.first_name ?? null,
          lastName: associated.last_name ?? null,
          locale: associated.locale ?? null,
          accountOwner: associated.account_owner ?? false,
          collaborator: associated.collaborator ?? false,
          lastLoginAt: now(),
        },
      },
      { upsert: true, returnDocument: 'after', setDefaultsOnInsert: true },
    ).lean<UserDoc>();

    const loginCode = randomToken(32);
    await LoginCodeModel.create({
      codeHash: sha256Hex(loginCode),
      userId: user._id,
      shopId: shop.id,
      codeChallenge: state.codeChallenge,
      expiresAt: new Date(now().getTime() + LOGIN_CODE_TTL_MS),
    });
    return { kind: 'redirect', location: deepLink({ code: loginCode }) };
  };

  return {
    async start(shopDomain, challenge) {
      const phase: OauthPhase = needsOfflinePhase(await shops.getByDomain(shopDomain)) ? 'offline' : 'online';
      const nonce = await states.create(shopDomain, phase, challenge);
      return authorizeUrl(shopDomain, nonce, phase);
    },

    async landing(shopDomain) {
      if (!needsOfflinePhase(await shops.getByDomain(shopDomain))) return null;
      const nonce = await states.create(shopDomain, 'offline', null);
      return authorizeUrl(shopDomain, nonce, 'offline');
    },

    async callback(rawQuery, query) {
      if (!verifyOAuthQueryHmac(rawQuery, env.SHOPIFY_API_SECRET)) {
        throw AppError.forbidden('Invalid request signature');
      }
      const state = await states.consume(query.state);
      if (state === null) throw AppError.forbidden('Invalid or expired state');
      if (state.shopDomain !== query.shop) throw AppError.forbidden('State does not match the shop');

      try {
        return state.phase === 'offline' ? await completeOffline(state, query.code) : await completeOnline(state, query.code);
      } catch (err) {
        // The state is valid and a mobile app is waiting: hand it the failure instead of a browser error page.
        if (!state.codeChallenge) throw err;
        logger.warn({ err, shopDomain: state.shopDomain, phase: state.phase }, 'oauth callback failed');
        return { kind: 'redirect', location: deepLink({ error: err instanceof AppError ? err.code : 'internal' }) };
      }
    },
  };
}
