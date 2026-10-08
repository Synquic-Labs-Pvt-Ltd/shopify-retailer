import request from 'supertest';
import { DEFAULT_SHOPIFY_USER_ID, signSessionTokenSync, type SessionTokenSpec } from '../../helpers/session-token';
import type { Requester } from './client';
import type { E2e } from './harness';

// The embedded app's view of the API: every request carries a fresh App Bridge session token (they live one minute),
// exactly as the Shopify admin iframe sends them. No login, no refresh token.
export interface EmbeddedClient extends Requester {
  readonly shopDomain: string;
  // A new session token for this staff member, with optional claim overrides.
  token(spec?: Partial<SessionTokenSpec>): string;
}

export function embeddedClient(e2e: E2e, shopDomain: string, sub: string | number = DEFAULT_SHOPIFY_USER_ID): EmbeddedClient {
  const token = (spec: Partial<SessionTokenSpec> = {}): string =>
    signSessionTokenSync({ shop: shopDomain, sub, apiKey: e2e.env.SHOPIFY_API_KEY, apiSecret: e2e.env.SHOPIFY_API_SECRET, ...spec });
  const authorize = (test: request.Test): request.Test => test.set('authorization', `Bearer ${token()}`);
  return {
    shopDomain,
    token,
    get: (path) => authorize(request(e2e.app).get(path)),
    post: (path, body) => authorize(request(e2e.app).post(path)).send(body ?? {}),
    delete: (path) => authorize(request(e2e.app).delete(path)),
  };
}
