import type { Request } from 'express';
import { AppError } from '../../core/errors';
import type { ShopsInternalService } from '../shops';
import { createEmbeddedAuth } from './embedded';
import type { AuthContext, AuthService } from './index';
import type { JwtService } from './jwt';
import { LoginCodeModel, OAuthStateModel, SessionModel, UserModel } from './models';
import { looksLikeSessionToken } from './session-token';
import type { SessionService } from './sessions';

export interface AuthServiceDeps {
  shops: Pick<ShopsInternalService, 'requireActive' | 'getById' | 'ensureOfflineToken'>;
  jwt: JwtService;
  sessions: Pick<SessionService, 'revokeAllForShop'>;
  // The Shopify app credentials: aud and HS256 key of the App Bridge session tokens.
  shopify: { apiKey: string; apiSecret: string };
  now: () => Date;
}

const BEARER = /^Bearer\s+(\S+)$/i;

const bearerOf = (req: Request): string | undefined => BEARER.exec(req.header('authorization') ?? '')?.[1];

export function createAuthService(deps: AuthServiceDeps): AuthService {
  const { shops, jwt, sessions } = deps;
  const embedded = createEmbeddedAuth({ shops, apiKey: deps.shopify.apiKey, apiSecret: deps.shopify.apiSecret, now: deps.now });

  const verifyAccessToken = async (token: string): Promise<AuthContext> => {
    const claims = await jwt.verify(token);
    return { userId: claims.sub, shopId: claims.shopId, shopDomain: claims.shopDomain };
  };

  // Our own access JWT first (the mobile app, unchanged). A token that is not ours and carries a dest claim is
  // tried as a Shopify session token (the embedded web app). Anything else fails exactly as it always did.
  const authenticate = async (token: string): Promise<AuthContext> => {
    let context: AuthContext;
    try {
      context = await verifyAccessToken(token);
    } catch (err) {
      if (!looksLikeSessionToken(token)) throw err;
      return embedded.authenticate(token);
    }
    // 409 shop_reauth_required when the shop is uninstalled or needs a new offline login.
    const shop = await shops.requireActive(context.shopId);
    if (shop.shopDomain !== context.shopDomain) throw AppError.unauthorized('Invalid or expired access token');
    return context;
  };

  return {
    verifyAccessToken,

    async requireAuth(req, _res, next) {
      try {
        const token = bearerOf(req);
        if (token === undefined) throw AppError.unauthorized();
        Object.assign(req, { auth: await authenticate(token) });
        next();
      } catch (err) {
        next(err);
      }
    },

    // Only a signature-verified token yields a key, so nobody can spend another user's budget with a forged one.
    async rateLimitKey(req) {
      const token = bearerOf(req);
      if (token === undefined) return null;
      try {
        const claims = await jwt.verify(token);
        return `user:${claims.shopId}:${claims.sub}`;
      } catch {
        // Not one of our tokens.
      }
      if (!looksLikeSessionToken(token)) return null;
      try {
        const claims = await embedded.verify(token);
        return `shop:${claims.shopDomain}:${claims.shopifyUserId}`;
      } catch {
        return null;
      }
    },

    revokeAllSessions: (shopId) => sessions.revokeAllForShop(shopId),

    // Must run before the shop document is deleted: oauth_states are keyed by domain.
    async purgeShop(shopId) {
      const shop = await shops.getById(shopId);
      await Promise.all([
        UserModel.deleteMany({ shopId }),
        SessionModel.deleteMany({ shopId }),
        LoginCodeModel.deleteMany({ shopId }),
        shop === null ? Promise.resolve() : OAuthStateModel.deleteMany({ shopDomain: shop.shopDomain }),
      ]);
    },
  };
}
