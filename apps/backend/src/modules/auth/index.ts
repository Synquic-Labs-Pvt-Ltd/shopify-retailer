import type { Request, RequestHandler } from 'express';

export interface AuthContext {
  userId: string;
  shopId: string;
  shopDomain: string;
}

// A request after requireAuth has run.
export type AuthenticatedRequest = Request & { auth: AuthContext };

export interface AuthService {
  // Verifies the bearer JWT, loads the shop and sets req.auth. 401 unauthorized, 409 shop_reauth_required.
  requireAuth: RequestHandler;
  verifyAccessToken(token: string): Promise<AuthContext>;
  // app/uninstalled: revokes every session of the shop.
  revokeAllSessions(shopId: string): Promise<void>;
  // shop/redact: deletes users, sessions, login codes and oauth states of the shop.
  purgeShop(shopId: string): Promise<void>;
}
