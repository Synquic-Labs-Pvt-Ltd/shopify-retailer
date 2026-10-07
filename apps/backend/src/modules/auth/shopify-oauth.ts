import { z } from 'zod';
import { AppError } from '../../core/errors';
import type { Logger } from '../../core/logger';
import type { ShopInfo } from '../shops';

const REQUEST_TIMEOUT_MS = 30_000;

const tokenResponseSchema = z.object({
  access_token: z.string().min(1),
  scope: z.string(),
  expires_in: z.number().positive().optional(),
  refresh_token: z.string().min(1).optional(),
  refresh_token_expires_in: z.number().positive().optional(),
  associated_user: z
    .object({
      id: z.union([z.number(), z.string()]).transform(String),
      first_name: z.string().nullish(),
      last_name: z.string().nullish(),
      email: z.string().nullish(),
      locale: z.string().nullish(),
      account_owner: z.boolean().optional(),
      collaborator: z.boolean().optional(),
    })
    .optional(),
});

export type TokenExchangeResponse = z.output<typeof tokenResponseSchema>;

export interface ShopifyOAuthClient {
  // Authorization-code exchange. The offline phase sends expiring=1 (expiring offline token + refresh token).
  exchangeCode(shopDomain: string, code: string, options: { expiring: boolean }): Promise<TokenExchangeResponse>;
  // Best effort: null when the shop query fails, so a login never depends on it.
  fetchShopInfo(shopDomain: string, accessToken: string): Promise<ShopInfo | null>;
}

export interface ShopifyOAuthDeps {
  fetchImpl: typeof fetch;
  logger: Logger;
  clientId: string;
  clientSecret: string;
  apiVersion: string;
}

const shopQueryResponseSchema = z.object({
  data: z.object({
    shop: z.object({
      id: z.string(),
      name: z.string().nullish(),
      email: z.string().nullish(),
      currencyCode: z.string().nullish(),
      ianaTimezone: z.string().nullish(),
    }),
  }),
});

const SHOP_QUERY = '{ shop { id name email currencyCode ianaTimezone } }';

export function createShopifyOAuthClient(deps: ShopifyOAuthDeps): ShopifyOAuthClient {
  const { fetchImpl, logger } = deps;

  return {
    async exchangeCode(shopDomain, code, options) {
      const body = new URLSearchParams({ client_id: deps.clientId, client_secret: deps.clientSecret, code });
      if (options.expiring) body.set('expiring', '1');

      let response: Response;
      try {
        response = await fetchImpl(`https://${shopDomain}/admin/oauth/access_token`, {
          method: 'POST',
          headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
          body,
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        });
      } catch (err) {
        throw new AppError('internal', 'Could not reach Shopify', { status: 502, cause: err });
      }

      if (response.status === 400 || response.status === 401 || response.status === 403) {
        logger.warn({ status: response.status, shopDomain }, 'Shopify rejected the authorization code');
        throw AppError.forbidden('Shopify rejected the authorization code');
      }
      if (!response.ok) {
        logger.error({ status: response.status, shopDomain }, 'authorization code exchange failed');
        throw new AppError('internal', 'Shopify token exchange failed', { status: 502 });
      }
      const parsed = tokenResponseSchema.safeParse(await response.json().catch(() => null));
      if (!parsed.success) {
        logger.error({ shopDomain }, 'authorization code exchange returned an unexpected body');
        throw new AppError('internal', 'Shopify returned an unexpected token response', { status: 502 });
      }
      return parsed.data;
    },

    async fetchShopInfo(shopDomain, accessToken) {
      try {
        const response = await fetchImpl(`https://${shopDomain}/admin/api/${deps.apiVersion}/graphql.json`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            accept: 'application/json',
            'x-shopify-access-token': accessToken,
          },
          body: JSON.stringify({ query: SHOP_QUERY }),
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const { shop } = shopQueryResponseSchema.parse(await response.json()).data;
        return {
          shopGid: shop.id,
          name: shop.name ?? null,
          email: shop.email ?? null,
          currencyCode: shop.currencyCode ?? null,
          ianaTimezone: shop.ianaTimezone ?? null,
        };
      } catch (err) {
        logger.warn({ err, shopDomain }, 'could not fetch shop info after install');
        return null;
      }
    },
  };
}
