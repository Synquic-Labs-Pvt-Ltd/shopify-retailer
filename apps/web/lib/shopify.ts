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
