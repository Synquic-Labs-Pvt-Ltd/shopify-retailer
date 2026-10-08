import type { ShopsInternalService } from '../shops';
import type { AuthContext } from './index';
import { UserModel, type UserDoc } from './models';
import { verifyShopifySessionToken, type ShopifySessionClaims } from './session-token';

// A user that shows up with a session token has their lastLoginAt refreshed at most this often, so an embedded
// page that fires many requests a minute does not write on every one of them.
export const LAST_SEEN_INTERVAL_MS = 5 * 60_000;

export interface EmbeddedAuthDeps {
  shops: Pick<ShopsInternalService, 'ensureOfflineToken'>;
  apiKey: string;
  apiSecret: string;
  now: () => Date;
}

export interface EmbeddedAuth {
  // Signature and claim checks only: no database access, no exchange. Throws 401 unauthorized.
  verify(token: string): Promise<ShopifySessionClaims>;
  // Verifies the session token, makes sure the shop has a usable offline token (exchanging the session token for one
  // when it has none), and maps the Shopify staff user to our users collection.
  // Throws 401 unauthorized, 409 shop_reauth_required (Shopify refused the token) or 502 (Shopify unreachable).
  authenticate(token: string): Promise<AuthContext>;
}

function isDuplicateKey(err: unknown): boolean {
  return typeof err === 'object' && err !== null && 'code' in err && err.code === 11000;
}

export function createEmbeddedAuth(deps: EmbeddedAuthDeps): EmbeddedAuth {
  const { now } = deps;

  const verify = (token: string): Promise<ShopifySessionClaims> =>
    verifyShopifySessionToken(token, { apiKey: deps.apiKey, apiSecret: deps.apiSecret, now });

  // The staff user is identified by Shopify's user id only: the session token carries no email or name, so a user
  // created here has those fields empty and a user that logged in on the phone keeps the profile it has.
  const upsertUser = async (shopId: string, shopifyUserId: string): Promise<string> => {
    const existing = await UserModel.findOne({ shopId, shopifyUserId }, { lastLoginAt: 1 }).lean();
    if (existing?.lastLoginAt && now().getTime() - existing.lastLoginAt.getTime() < LAST_SEEN_INTERVAL_MS) {
      return existing._id.toHexString();
    }

    for (let attempt = 0; ; attempt++) {
      try {
        const user = await UserModel.findOneAndUpdate(
          { shopId, shopifyUserId },
          { $set: { lastLoginAt: now() } },
          { upsert: true, returnDocument: 'after', setDefaultsOnInsert: true },
        ).lean<UserDoc>();
        return user._id.toHexString();
      } catch (err) {
        // Two requests created the same user at once; the unique index let one win. The retry updates it.
        if (attempt === 0 && isDuplicateKey(err)) continue;
        throw err;
      }
    }
  };

  // Concurrent requests of one user share a single lookup/write.
  const lookups = new Map<string, Promise<string>>();
  const touchUser = (shopId: string, shopifyUserId: string): Promise<string> => {
    const key = `${shopId}:${shopifyUserId}`;
    const running = lookups.get(key);
    if (running !== undefined) return running;
    const started = upsertUser(shopId, shopifyUserId).finally(() => lookups.delete(key));
    lookups.set(key, started);
    return started;
  };

  return {
    verify,

    async authenticate(token) {
      const claims = await verify(token);
      const shop = await deps.shops.ensureOfflineToken(claims.shopDomain, token);
      const userId = await touchUser(shop.id, claims.shopifyUserId);
      return { userId, shopId: shop.id, shopDomain: shop.shopDomain };
    },
  };
}
