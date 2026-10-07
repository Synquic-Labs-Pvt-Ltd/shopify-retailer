import { AppError } from '../../core/errors';
import type { ShopsService } from '../shops';
import type { AuthContext, AuthService } from './index';
import type { JwtService } from './jwt';
import { LoginCodeModel, OAuthStateModel, SessionModel, UserModel } from './models';
import type { SessionService } from './sessions';

export interface AuthServiceDeps {
  shops: Pick<ShopsService, 'requireActive' | 'getById'>;
  jwt: JwtService;
  sessions: Pick<SessionService, 'revokeAllForShop'>;
}

const BEARER = /^Bearer\s+(\S+)$/i;

export function createAuthService(deps: AuthServiceDeps): AuthService {
  const { shops, jwt, sessions } = deps;

  const verifyAccessToken = async (token: string): Promise<AuthContext> => {
    const claims = await jwt.verify(token);
    return { userId: claims.sub, shopId: claims.shopId, shopDomain: claims.shopDomain };
  };

  return {
    verifyAccessToken,

    async requireAuth(req, _res, next) {
      try {
        const token = BEARER.exec(req.header('authorization') ?? '')?.[1];
        if (token === undefined) throw AppError.unauthorized();
        const context = await verifyAccessToken(token);
        // 409 shop_reauth_required when the shop is uninstalled or needs a new offline login.
        const shop = await shops.requireActive(context.shopId);
        if (shop.shopDomain !== context.shopDomain) throw AppError.unauthorized('Invalid or expired access token');
        Object.assign(req, { auth: context });
        next();
      } catch (err) {
        next(err);
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
