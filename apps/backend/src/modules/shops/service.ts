import { AppError } from '../../core/errors';
import { createSecretBox } from './crypto';
import { ShopModel, type ShopDoc } from './model';
import { requestTokenRefresh, type RefreshedTokens } from './refresh';
import { parseScopes } from './scopes';
import type { OAuthTokenGrant, ShopInfo, ShopRecord, ShopsDeps, ShopsInternalService } from './index';

const REFRESH_MARGIN_MS = 5 * 60_000;
const REDACT_DELAY_MS = 48 * 3_600_000;
const DEFAULT_LOCK_MS = 60_000;
const DEFAULT_POLL_MS = 100;
// Waiters re-read until the lock holder finishes or its lock expires, plus this margin.
const WAIT_MARGIN_MS = 5_000;

const OBJECT_ID = /^[a-f0-9]{24}$/;

function toRecord(doc: ShopDoc): ShopRecord {
  return {
    id: doc._id.toHexString(),
    shopDomain: doc.shopDomain,
    shopGid: doc.shopGid ?? null,
    name: doc.name ?? null,
    email: doc.email ?? null,
    currencyCode: doc.currencyCode ?? null,
    ianaTimezone: doc.ianaTimezone ?? null,
    status: doc.status,
    scopes: doc.scopes,
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function createShopsService(deps: ShopsDeps): ShopsInternalService {
  const { env, logger } = deps;
  const fetchImpl = deps.fetchImpl ?? fetch;
  const now = deps.now ?? (() => new Date());
  const lockMs = deps.refreshLockMs ?? DEFAULT_LOCK_MS;
  const pollMs = deps.lockPollMs ?? DEFAULT_POLL_MS;
  const maxWaitLoops = Math.ceil((lockMs + WAIT_MARGIN_MS) / pollMs);
  const box = createSecretBox(env.TOKEN_ENC_KEY);

  const plusSeconds = (seconds: number): Date => new Date(now().getTime() + seconds * 1000);

  // Null expiry means a non-expiring token that never needs a refresh.
  const needsRefresh = (doc: ShopDoc): boolean => {
    const expiresAt = doc.offlineToken?.accessTokenExpiresAt;
    return expiresAt !== null && expiresAt !== undefined && expiresAt.getTime() - now().getTime() <= REFRESH_MARGIN_MS;
  };

  const refreshTokenDead = (doc: ShopDoc): boolean => {
    const token = doc.offlineToken;
    if (!token?.refreshTokenEnc) return true;
    const expiresAt = token.refreshTokenExpiresAt;
    return expiresAt !== null && expiresAt !== undefined && expiresAt.getTime() <= now().getTime();
  };

  const findById = async (shopId: string): Promise<ShopDoc | null> =>
    OBJECT_ID.test(shopId) ? ShopModel.findById(shopId).lean<ShopDoc>() : null;

  // Only wipes when the stored refresh token is still the one that was rejected, so a concurrent
  // OAuth callback that stored fresh tokens is never clobbered.
  const markReauthIf = async (shopId: string, refreshTokenEnc: string | null | undefined): Promise<void> => {
    await ShopModel.updateOne(
      { _id: shopId, status: 'active', 'offlineToken.refreshTokenEnc': refreshTokenEnc ?? null },
      { $set: { status: 'reauth_required' }, $unset: { offlineToken: '' } },
    );
    logger.warn({ shopId }, 'shop requires re-authorization');
  };

  const claimLock = async (shopId: string, lockUntil: Date): Promise<ShopDoc | null> =>
    ShopModel.findOneAndUpdate(
      {
        _id: shopId,
        status: 'active',
        $or: [{ 'offlineToken.refreshLockUntil': null }, { 'offlineToken.refreshLockUntil': { $lte: now() } }],
      },
      { $set: { 'offlineToken.refreshLockUntil': lockUntil } },
      { returnDocument: 'after' },
    ).lean<ShopDoc>();

  const releaseLock = async (shopId: string, lockUntil: Date): Promise<void> => {
    await ShopModel.updateOne(
      { _id: shopId, 'offlineToken.refreshLockUntil': lockUntil },
      { $set: { 'offlineToken.refreshLockUntil': null } },
    );
  };

  // Compare-and-set on the refresh token we presented: a concurrent OAuth exchange retires it.
  const storeRefreshed = async (shopId: string, previousRefreshEnc: string, tokens: RefreshedTokens): Promise<boolean> => {
    const updated = await ShopModel.updateOne(
      { _id: shopId, 'offlineToken.refreshTokenEnc': previousRefreshEnc },
      {
        $set: {
          'offlineToken.accessTokenEnc': box.encrypt(tokens.accessToken),
          'offlineToken.accessTokenExpiresAt': plusSeconds(tokens.expiresInSeconds),
          'offlineToken.refreshTokenEnc': box.encrypt(tokens.refreshToken),
          'offlineToken.refreshTokenExpiresAt': plusSeconds(tokens.refreshTokenExpiresInSeconds),
          'offlineToken.refreshLockUntil': null,
        },
      },
    );
    return updated.modifiedCount === 1;
  };

  // Called with the lock held. Returns the access token, or null when the stored state changed under us
  // and the caller must re-read.
  const refreshWithLock = async (doc: ShopDoc, lockUntil: Date): Promise<string | null> => {
    const shopId = doc._id.toHexString();
    const token = doc.offlineToken;
    if (!token?.accessTokenEnc || !token.refreshTokenEnc) return null;

    // Another instance may have refreshed between our read and our lock claim.
    if (!needsRefresh(doc)) {
      await releaseLock(shopId, lockUntil);
      return box.decrypt(token.accessTokenEnc);
    }

    let outcome;
    try {
      outcome = await requestTokenRefresh({
        fetchImpl,
        logger,
        shopDomain: doc.shopDomain,
        clientId: env.SHOPIFY_API_KEY,
        clientSecret: env.SHOPIFY_API_SECRET,
        refreshToken: box.decrypt(token.refreshTokenEnc),
      });
    } catch (err) {
      await releaseLock(shopId, lockUntil);
      throw AppError.internal('Could not refresh the Shopify access token', err);
    }

    if (outcome.kind === 'refreshed') {
      if (await storeRefreshed(shopId, token.refreshTokenEnc, outcome.tokens)) return outcome.tokens.accessToken;
      logger.warn({ shopId }, 'token refresh result discarded: tokens were replaced concurrently');
      return null;
    }

    if (outcome.kind === 'terminal') {
      await markReauthIf(shopId, token.refreshTokenEnc);
      throw AppError.shopReauthRequired();
    }

    await releaseLock(shopId, lockUntil);
    const reason = outcome.kind === 'transient' ? outcome.reason : `HTTP ${outcome.status}`;
    throw new AppError('internal', 'Could not refresh the Shopify access token', {
      status: 502,
      details: { upstream: 'shopify', reason },
    });
  };

  return {
    async getById(shopId) {
      const doc = await findById(shopId);
      return doc === null ? null : toRecord(doc);
    },

    async getByDomain(shopDomain) {
      const doc = await ShopModel.findOne({ shopDomain: shopDomain.toLowerCase() }).lean<ShopDoc>();
      return doc === null ? null : toRecord(doc);
    },

    async requireActive(shopId) {
      const doc = await findById(shopId);
      if (doc === null || doc.status !== 'active') throw AppError.shopReauthRequired();
      return toRecord(doc);
    },

    async getAccessToken(shopId) {
      for (let attempt = 0; attempt < maxWaitLoops; attempt++) {
        const doc = await findById(shopId);
        if (doc === null || doc.status !== 'active') throw AppError.shopReauthRequired();

        const token = doc.offlineToken;
        if (!token?.accessTokenEnc) {
          await markReauthIf(shopId, token?.refreshTokenEnc);
          throw AppError.shopReauthRequired();
        }
        if (!needsRefresh(doc)) return box.decrypt(token.accessTokenEnc);

        if (refreshTokenDead(doc)) {
          await markReauthIf(shopId, token.refreshTokenEnc);
          throw AppError.shopReauthRequired();
        }

        const lockUntil = new Date(now().getTime() + lockMs);
        const claimed = await claimLock(shopId, lockUntil);
        if (claimed === null) {
          await sleep(pollMs);
          continue;
        }

        const accessToken = await refreshWithLock(claimed, lockUntil);
        if (accessToken !== null) return accessToken;
      }
      throw AppError.internal('Timed out waiting for the Shopify token refresh');
    },

    async upsertFromOAuth(grant: OAuthTokenGrant) {
      const shopDomain = grant.shopDomain.toLowerCase();
      const existing = await ShopModel.findOne({ shopDomain }, 'status').lean<Pick<ShopDoc, 'status'>>();
      const freshInstall = existing === null || existing.status === 'uninstalled';

      const doc = await ShopModel.findOneAndUpdate(
        { shopDomain },
        {
          $set: {
            status: 'active',
            scopes: parseScopes(grant.scope),
            offlineToken: {
              accessTokenEnc: box.encrypt(grant.accessToken),
              accessTokenExpiresAt: grant.expiresInSeconds === null ? null : plusSeconds(grant.expiresInSeconds),
              refreshTokenEnc: grant.refreshToken === null ? null : box.encrypt(grant.refreshToken),
              refreshTokenExpiresAt:
                grant.refreshTokenExpiresInSeconds === null ? null : plusSeconds(grant.refreshTokenExpiresInSeconds),
              refreshLockUntil: null,
            },
            ...(freshInstall ? { installedAt: now() } : {}),
          },
          $unset: { uninstalledAt: '', redactAfter: '' },
        },
        { upsert: true, returnDocument: 'after', setDefaultsOnInsert: true },
      ).lean<ShopDoc>();
      return toRecord(doc);
    },

    async saveShopInfo(shopId: string, info: ShopInfo) {
      if (!OBJECT_ID.test(shopId)) return null;
      const doc = await ShopModel.findByIdAndUpdate(shopId, { $set: info }, { returnDocument: 'after' }).lean<ShopDoc>();
      return doc === null ? null : toRecord(doc);
    },

    async markReauthRequired(shopId) {
      if (!OBJECT_ID.test(shopId)) return;
      await ShopModel.updateOne({ _id: shopId, status: 'active' }, { $set: { status: 'reauth_required' }, $unset: { offlineToken: '' } });
      logger.warn({ shopId }, 'shop requires re-authorization');
    },

    async markUninstalled(shopDomain) {
      const domain = shopDomain.toLowerCase();
      const existing = await ShopModel.findOne({ shopDomain: domain }).lean<ShopDoc>();
      if (existing === null) return null;
      // A retried webhook must not move redactAfter.
      if (existing.status === 'uninstalled') return toRecord(existing);

      const doc = await ShopModel.findOneAndUpdate(
        { shopDomain: domain },
        {
          $set: { status: 'uninstalled', scopes: [], uninstalledAt: now(), redactAfter: new Date(now().getTime() + REDACT_DELAY_MS) },
          $unset: { offlineToken: '' },
        },
        { returnDocument: 'after' },
      ).lean<ShopDoc>();
      return doc === null ? null : toRecord(doc);
    },

    async purgeShop(shopId) {
      if (!OBJECT_ID.test(shopId)) return;
      await ShopModel.deleteOne({ _id: shopId });
    },
  };
}
