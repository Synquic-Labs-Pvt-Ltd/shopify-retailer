import { z } from 'zod';
import type { Logger } from '../../core/logger';
import type { ShopInfo } from './index';

const REQUEST_TIMEOUT_MS = 30_000;

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

export interface ShopInfoRequest {
  fetchImpl: typeof fetch;
  logger: Logger;
  apiVersion: string;
}

// Best effort: null when the shop query fails, so an install or a login never depends on it.
// Shared by the OAuth callback (auth module) and the session token exchange (shops module).
export async function fetchShopInfo(request: ShopInfoRequest, shopDomain: string, accessToken: string): Promise<ShopInfo | null> {
  try {
    const response = await request.fetchImpl(`https://${shopDomain}/admin/api/${request.apiVersion}/graphql.json`, {
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
    request.logger.warn({ err, shopDomain }, 'could not fetch shop info after install');
    return null;
  }
}
