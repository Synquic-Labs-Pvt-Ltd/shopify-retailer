import { z } from 'zod';
import type { Logger } from '../../core/logger';

const REFRESH_TIMEOUT_MS = 30_000;

// Shopify docs: "refresh_token_expires_in is 7776000 (90 days) when issued".
export const DEFAULT_REFRESH_TOKEN_TTL_SECONDS = 7_776_000;

const refreshResponseSchema = z.object({
  access_token: z.string().min(1),
  refresh_token: z.string().min(1),
  expires_in: z.number().positive(),
  refresh_token_expires_in: z.number().positive().optional(),
});

export interface RefreshedTokens {
  accessToken: string;
  refreshToken: string;
  expiresInSeconds: number;
  refreshTokenExpiresInSeconds: number;
}

// Mirrors Shopify's documented refresh handling:
// 401 is terminal (expired, revoked, replaced or uninstalled), 429, 5xx and network errors are
// transient, any other status is a permanent error that retrying cannot fix.
export type RefreshOutcome =
  | { kind: 'refreshed'; tokens: RefreshedTokens }
  | { kind: 'terminal' }
  | { kind: 'transient'; reason: string }
  | { kind: 'failed'; status: number };

export interface RefreshRequest {
  fetchImpl: typeof fetch;
  logger: Logger;
  shopDomain: string;
  clientId: string;
  clientSecret: string;
  refreshToken: string;
}

export async function requestTokenRefresh(request: RefreshRequest): Promise<RefreshOutcome> {
  let response: Response;
  try {
    response = await request.fetchImpl(`https://${request.shopDomain}/admin/oauth/access_token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
      body: new URLSearchParams({
        client_id: request.clientId,
        client_secret: request.clientSecret,
        grant_type: 'refresh_token',
        refresh_token: request.refreshToken,
      }),
      signal: AbortSignal.timeout(REFRESH_TIMEOUT_MS),
    });
  } catch (err) {
    request.logger.warn({ err, shopDomain: request.shopDomain }, 'token refresh request did not reach Shopify');
    return { kind: 'transient', reason: 'network error' };
  }

  if (response.status === 401) return { kind: 'terminal' };
  if (response.status === 429 || response.status >= 500) return { kind: 'transient', reason: `HTTP ${response.status}` };
  if (!response.ok) {
    request.logger.error({ status: response.status, shopDomain: request.shopDomain }, 'token refresh rejected');
    return { kind: 'failed', status: response.status };
  }

  const parsed = refreshResponseSchema.safeParse(await response.json().catch(() => null));
  if (!parsed.success) {
    request.logger.error({ shopDomain: request.shopDomain }, 'token refresh returned an unexpected body');
    return { kind: 'failed', status: response.status };
  }
  const body = parsed.data;
  return {
    kind: 'refreshed',
    tokens: {
      accessToken: body.access_token,
      refreshToken: body.refresh_token,
      expiresInSeconds: body.expires_in,
      refreshTokenExpiresInSeconds: body.refresh_token_expires_in ?? DEFAULT_REFRESH_TOKEN_TTL_SECONDS,
    },
  };
}
