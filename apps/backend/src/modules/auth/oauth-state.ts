import type { OauthPhase } from '@rs/shared';
import { randomToken } from './crypto';
import { OAuthStateModel, type OAuthStateDoc } from './models';

export const OAUTH_STATE_TTL_MS = 10 * 60_000;

export interface OAuthStateStore {
  // Creates a single-use state nonce. codeChallenge is null for flows started from the landing page.
  create(shopDomain: string, phase: OauthPhase, codeChallenge: string | null): Promise<string>;
  // Atomically marks the nonce consumed. Returns null when it is unknown, used or expired.
  consume(nonce: string): Promise<OAuthStateDoc | null>;
}

export function createOAuthStateStore(now: () => Date): OAuthStateStore {
  return {
    async create(shopDomain, phase, codeChallenge) {
      const nonce = randomToken(32);
      await OAuthStateModel.create({
        nonce,
        shopDomain,
        phase,
        codeChallenge,
        expiresAt: new Date(now().getTime() + OAUTH_STATE_TTL_MS),
      });
      return nonce;
    },

    consume(nonce) {
      return OAuthStateModel.findOneAndUpdate(
        { nonce, consumedAt: null, expiresAt: { $gt: now() } },
        { $set: { consumedAt: now() } },
      ).lean<OAuthStateDoc>();
    },
  };
}
