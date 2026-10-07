import { z } from 'zod';

export const SHOP_DOMAIN_SUFFIX = '.myshopify.com';
export const SHOP_DOMAIN_REGEX = /^[a-z0-9][a-z0-9-]*\.myshopify\.com$/;

export const shopDomainSchema = z.string().regex(SHOP_DOMAIN_REGEX, 'Invalid Shopify store domain');

// SPEC 8.3 step 1: lowercase, append .myshopify.com if missing. Validate the result separately.
export function normalizeShopDomain(input: string): string {
  const value = input.trim().toLowerCase();
  return value.endsWith(SHOP_DOMAIN_SUFFIX) ? value : `${value}${SHOP_DOMAIN_SUFFIX}`;
}

export function isValidShopDomain(value: string): boolean {
  return SHOP_DOMAIN_REGEX.test(value);
}
