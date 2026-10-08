// The App Bridge global (`window.shopify`) is injected by https://cdn.shopify.com/shopifycloud/app-bridge.js
// when the app runs inside the Shopify admin. Mock mode replaces it so the app also works in a plain tab.

export const MOCK = process.env.NEXT_PUBLIC_MOCK === '1';

interface ShopifyGlobal {
  idToken(): Promise<string>;
  toast: { show(message: string, options?: { isError?: boolean; duration?: number }): void };
}

declare global {
  interface Window {
    shopify?: ShopifyGlobal;
  }
}

export const DEV_TOAST_EVENT = 'rs:toast';

export interface DevToastDetail {
  message: string;
  isError: boolean;
}

// True inside the Shopify admin iframe. False in a plain tab (development and mock mode).
export function isEmbedded(): boolean {
  return typeof window !== 'undefined' && !MOCK && window.top !== window.self;
}

// A fresh session token for every API call: it is only valid for one minute.
export async function getSessionToken(): Promise<string> {
  if (MOCK) return 'mock-session-token';
  const bridge = typeof window === 'undefined' ? undefined : window.shopify;
  if (bridge === undefined) throw new Error('Shopify App Bridge is not loaded. Open the app from the Shopify admin.');
  return bridge.idToken();
}

export function showToast(message: string, isError = false): void {
  if (typeof window === 'undefined') return;
  if (!MOCK && window.shopify !== undefined) {
    window.shopify.toast.show(message, { isError });
    return;
  }
  window.dispatchEvent(new CustomEvent<DevToastDetail>(DEV_TOAST_EVENT, { detail: { message, isError } }));
}

const SHOP_PATTERN = /^[a-z0-9][a-z0-9-]*\.myshopify\.com$/;

// The shop that Shopify adds to the URL when it launches the app, or null when it is missing or not a myshopify host.
export function readShopParam(search: string): string | null {
  const shop = new URLSearchParams(search).get('shop');
  return shop !== null && SHOP_PATTERN.test(shop) ? shop : null;
}

// Where the merchant opens the app inside their admin. Shopify routes /admin/apps/<client id> to the app's own page.
export function adminAppUrl(shop: string, apiKey: string): string {
  return `https://${shop}/admin/apps/${encodeURIComponent(apiKey)}`;
}
