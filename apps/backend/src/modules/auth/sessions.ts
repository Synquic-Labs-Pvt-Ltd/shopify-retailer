import { randomUUID } from 'node:crypto';
import { Types } from 'mongoose';
import type { AuthExchangeRequest, AuthSessionResponse, SessionPlatform, Shop, User } from '@rs/shared';
import { AppError } from '../../core/errors';
import type { Logger } from '../../core/logger';
import type { ShopRecord, ShopsService } from '../shops';
import { randomToken, sha256Hex, verifyPkce } from './crypto';
import type { JwtService } from './jwt';
import { LoginCodeModel, SessionModel, UserModel, type SessionDoc, type UserDoc } from './models';

export const REFRESH_TOKEN_TTL_MS = 30 * 24 * 3_600_000;
const REFRESH_TOKEN_BYTES = 48;

export interface SessionServiceDeps {
  logger: Logger;
  shops: Pick<ShopsService, 'requireActive'>;
  jwt: JwtService;
  now: () => Date;
}

export interface SessionService {
  // POST /api/v1/auth/exchange: single-use login code plus the PKCE verifier.
  exchange(request: AuthExchangeRequest): Promise<AuthSessionResponse>;
  // POST /api/v1/auth/refresh: rotates the token; reuse of a rotated token revokes the whole family.
  refresh(refreshToken: string): Promise<AuthSessionResponse>;
  // POST /api/v1/auth/logout: revokes the session chain. Unknown tokens are ignored.
  logout(refreshToken: string): Promise<void>;
  revokeAllForShop(shopId: string): Promise<void>;
}

export function toUserDto(user: Pick<UserDoc, '_id' | 'email' | 'firstName' | 'lastName'>): User {
  return {
    id: user._id.toHexString(),
    email: user.email ?? null,
    firstName: user.firstName ?? null,
    lastName: user.lastName ?? null,
  };
}

// name falls back to the domain when Shopify returned none (shopSchema in @rs/shared).
export function toShopDto(shop: ShopRecord): Shop {
  return { id: shop.id, domain: shop.shopDomain, name: shop.name ?? shop.shopDomain };
}

export function createSessionService(deps: SessionServiceDeps): SessionService {
  const { logger, shops, jwt, now } = deps;

  const revokeFamily = async (familyId: string): Promise<void> => {
    await SessionModel.updateMany({ familyId, revokedAt: null }, { $set: { revokedAt: now() } });
  };

  const insertSession = async (input: {
    sessionId: Types.ObjectId;
    familyId: string;
    userId: Types.ObjectId;
    shopId: string;
    platform: SessionPlatform | undefined;
    deviceName: string | undefined;
  }): Promise<string> => {
    const refreshToken = randomToken(REFRESH_TOKEN_BYTES);
    const issuedAt = now();
    await SessionModel.create({
      _id: input.sessionId,
      userId: input.userId,
      shopId: input.shopId,
      refreshTokenHash: sha256Hex(refreshToken),
      familyId: input.familyId,
      platform: input.platform,
      deviceName: input.deviceName,
      lastUsedAt: issuedAt,
      expiresAt: new Date(issuedAt.getTime() + REFRESH_TOKEN_TTL_MS),
    });
    return refreshToken;
  };

  const respond = async (
    user: Pick<UserDoc, '_id' | 'email' | 'firstName' | 'lastName'>,
    shop: ShopRecord,
    refreshToken: string,
  ): Promise<AuthSessionResponse> => {
    const access = await jwt.sign({ userId: user._id.toHexString(), shopId: shop.id, shopDomain: shop.shopDomain });
    return {
      accessToken: access.token,
      accessTokenExpiresAt: access.expiresAt.toISOString(),
      refreshToken,
      user: toUserDto(user),
      shop: toShopDto(shop),
    };
  };

  return {
    async exchange(request) {
      // Claiming the code is one atomic update, so it is single use even under concurrent requests.
      // A wrong verifier still burns the code, which stops verifier guessing.
      const claimed = await LoginCodeModel.findOneAndUpdate(
        { codeHash: sha256Hex(request.code), consumedAt: null, expiresAt: { $gt: now() } },
        { $set: { consumedAt: now() } },
      ).lean();
      if (claimed === null) throw AppError.unauthorized('Invalid or expired login code');
      if (!verifyPkce(request.codeVerifier, claimed.codeChallenge)) {
        logger.warn({ shopId: claimed.shopId.toHexString() }, 'login code presented with a wrong PKCE verifier');
        throw AppError.unauthorized('Invalid or expired login code');
      }

      const user = await UserModel.findById(claimed.userId).lean<UserDoc>();
      if (user === null) throw AppError.unauthorized('Invalid or expired login code');
      const shop = await shops.requireActive(claimed.shopId.toHexString());

      const refreshToken = await insertSession({
        sessionId: new Types.ObjectId(),
        familyId: randomUUID(),
        userId: user._id,
        shopId: shop.id,
        platform: request.platform,
        deviceName: request.deviceName,
      });
      return respond(user, shop, refreshToken);
    },

    async refresh(refreshToken) {
      const current = await SessionModel.findOne({ refreshTokenHash: sha256Hex(refreshToken) }).lean<SessionDoc>();
      if (current === null) throw AppError.unauthorized('Invalid refresh token');

      if (current.replacedBySessionId) {
        await revokeFamily(current.familyId);
        logger.warn({ familyId: current.familyId, shopId: current.shopId.toHexString() }, 'refresh token reuse detected, session family revoked');
        throw AppError.unauthorized('Invalid refresh token');
      }
      if (current.revokedAt || current.expiresAt.getTime() <= now().getTime()) {
        throw AppError.unauthorized('Invalid refresh token');
      }

      const user = await UserModel.findById(current.userId).lean<UserDoc>();
      if (user === null) throw AppError.unauthorized('Invalid refresh token');
      const shop = await shops.requireActive(current.shopId.toHexString());

      // Insert the successor first so a database error cannot burn the caller's only token.
      const successorId = new Types.ObjectId();
      const nextRefreshToken = await insertSession({
        sessionId: successorId,
        familyId: current.familyId,
        userId: current.userId,
        shopId: shop.id,
        platform: current.platform,
        deviceName: current.deviceName,
      });

      const claimed = await SessionModel.findOneAndUpdate(
        { _id: current._id, revokedAt: null, replacedBySessionId: null },
        { $set: { replacedBySessionId: successorId, revokedAt: now() } },
      ).lean();
      if (claimed === null) {
        // A concurrent request rotated or revoked the same token: treat it as reuse.
        await SessionModel.deleteOne({ _id: successorId });
        await revokeFamily(current.familyId);
        logger.warn({ familyId: current.familyId }, 'refresh token rotated concurrently, session family revoked');
        throw AppError.unauthorized('Invalid refresh token');
      }
      return respond(user, shop, nextRefreshToken);
    },

    async logout(refreshToken) {
      const session = await SessionModel.findOne({ refreshTokenHash: sha256Hex(refreshToken) }).lean<SessionDoc>();
      if (session !== null) await revokeFamily(session.familyId);
    },

    async revokeAllForShop(shopId) {
      const at = now();
      await SessionModel.updateMany({ shopId, revokedAt: null }, { $set: { revokedAt: at } });
      await LoginCodeModel.updateMany({ shopId, consumedAt: null }, { $set: { consumedAt: at } });
    },
  };
}
