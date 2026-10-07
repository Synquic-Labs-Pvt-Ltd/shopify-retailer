import * as WebBrowser from 'expo-web-browser';
import { API_BASE_URL, API_MOCK } from '../../api/client';
import { createPkcePair } from './pkce';

// The system browser returns here after Shopify login (SPEC 8.3 step 3). Matches the app.json scheme.
export const AUTH_REDIRECT_URL = 'retailerstudio://auth';
const MOCK_LOGIN_CODE = 'mock-login-code';

export type ShopifyLoginResult =
  | { kind: 'code'; code: string; codeVerifier: string }
  | { kind: 'cancelled' }
  | { kind: 'failed'; message: string };

// Reads one query parameter without URL/URLSearchParams, which React Native only partly implements.
export function readQueryParam(url: string, name: string): string | null {
  const queryStart = url.indexOf('?');
  if (queryStart === -1) return null;
  const hashStart = url.indexOf('#', queryStart);
  const query = url.slice(queryStart + 1, hashStart === -1 ? undefined : hashStart);
  for (const pair of query.split('&')) {
    const separator = pair.indexOf('=');
    const key = separator === -1 ? pair : pair.slice(0, separator);
    if (key !== name) continue;
    try {
      return decodeURIComponent((separator === -1 ? '' : pair.slice(separator + 1)).replace(/\+/g, ' '));
    } catch {
      return null;
    }
  }
  return null;
}

// Opens GET /auth/shopify/start in an auth session and waits for retailerstudio://auth?code=...
// Mock mode skips the browser and fabricates a code. `shop` must already be a valid .myshopify.com domain.
export async function runShopifyLogin(shop: string): Promise<ShopifyLoginResult> {
  const { verifier, challenge } = await createPkcePair();
  if (API_MOCK) return { kind: 'code', code: MOCK_LOGIN_CODE, codeVerifier: verifier };

  const startUrl = `${API_BASE_URL}/auth/shopify/start?shop=${encodeURIComponent(shop)}&challenge=${encodeURIComponent(challenge)}`;
  const result = await WebBrowser.openAuthSessionAsync(startUrl, AUTH_REDIRECT_URL);
  // Closing the browser, pressing back or dismissing the sheet is not an error.
  if (result.type !== 'success') return { kind: 'cancelled' };

  const code = readQueryParam(result.url, 'code');
  if (code === null || code === '') {
    return { kind: 'failed', message: 'Shopify login did not finish. Please try again.' };
  }
  return { kind: 'code', code, codeVerifier: verifier };
}
