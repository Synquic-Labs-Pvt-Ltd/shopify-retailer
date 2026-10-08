import { z } from 'zod';
import type { Logger } from '../../core/logger';
import { DEFAULT_REFRESH_TOKEN_TTL_SECONDS } from './refresh';
import type { OAuthTokenGrant } from './index';

const EXCHANGE_TIMEOUT_MS = 30_000;

// Shopify token exchange: an App Bridge session token (ID token) is traded for an expiring offline access token.
export const TOKEN_EXCHANGE_GRANT_TYPE = 'urn:ietf:params:oauth:grant-type:token-exchange';
export const ID_TOKEN_TYPE = 'urn:ietf:params:oauth:token-type:id_token';
export const OFFLINE_ACCESS_TOKEN_TYPE = 'urn:shopify:params:oauth:token-type:offline-access-token';

const exchangeResponseSchema = z.object({
  access_token: z.string().min(1),
  scope: z.string().optional(),
  expires_in: z.number().positive().optional(),
  refresh_token: z.string().min(1).optional(),
  refresh_token_expires_in: z.number().positive().optional(),
});

// 400, 401 and 403 mean Shopify does not accept the session token for this shop (expired, invalid, wrong app or
// the app is not installed): retrying with the same token cannot help. 429, 5xx and network errors are transient.
export type ExchangeOutcome =
  | { kind: 'exchanged'; grant: OAuthTokenGrant }
  | { kind: 'refused'; status: number }
  | { kind: 'transient'; reason: string }
  | { kind: 'failed'; status: number };

export interface ExchangeRequest {
  fetchImpl: typeof fetch;
  logger: Logger;
  shopDomain: string;
  clientId: string;
  clientSecret: string;
  idToken: string;
}

export async function requestSessionTokenExchange(request: ExchangeRequest): Promise<ExchangeOutcome> {
  let response: Response;
  try {
    response = await request.fetchImpl(`https://${request.shopDomain}/admin/oauth/access_token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
      body: new URLSearchParams({
        client_id: request.clientId,
        client_secret: request.clientSecret,
        grant_type: TOKEN_EXCHANGE_GRANT_TYPE,
        subject_token: request.idToken,
        subject_token_type: ID_TOKEN_TYPE,
        requested_token_type: OFFLINE_ACCESS_TOKEN_TYPE,
        expiring: '1',
      }),
      signal: AbortSignal.timeout(EXCHANGE_TIMEOUT_MS),
    });
  } catch (err) {
    request.logger.warn({ err, shopDomain: request.shopDomain }, 'token exchange request did not reach Shopify');
    return { kind: 'transient', reason: 'network error' };
  }

  if (response.status === 400 || response.status === 401 || response.status === 403) {
    request.logger.warn({ status: response.status, shopDomain: request.shopDomain }, 'Shopify refused the session token exchange');
    return { kind: 'refused', status: response.status };
  }
  if (response.status === 429 || response.status >= 500) return { kind: 'transient', reason: `HTTP ${response.status}` };
  if (!response.ok) {
    request.logger.error({ status: response.status, shopDomain: request.shopDomain }, 'token exchange rejected');
    return { kind: 'failed', status: response.status };
  }

  const parsed = exchangeResponseSchema.safeParse(await response.json().catch(() => null));
  if (!parsed.success) {
    request.logger.error({ shopDomain: request.shopDomain }, 'token exchange returned an unexpected body');
    return { kind: 'failed', status: response.status };
  }
  const body = parsed.data;
  return {
    kind: 'exchanged',
    grant: {
      shopDomain: request.shopDomain,
      accessToken: body.access_token,
      refreshToken: body.refresh_token ?? null,
      expiresInSeconds: body.expires_in ?? null,
      refreshTokenExpiresInSeconds:
        body.refresh_token === undefined ? null : (body.refresh_token_expires_in ?? DEFAULT_REFRESH_TOKEN_TTL_SECONDS),
      // Stored exactly as Shopify reports it.
      scope: body.scope ?? '',
    },
  };
}
