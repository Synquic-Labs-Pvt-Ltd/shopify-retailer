import { createHmac, timingSafeEqual } from 'node:crypto';

function compare(a: string, b: string): number {
  if (a < b) return -1;
  return a > b ? 1 : 0;
}

// Shopify signs the decoded query parameters: drop hmac, sort by key, join as key=value with "&",
// then HMAC-SHA256 with the app secret, hex encoded.
export function oauthQueryDigest(params: URLSearchParams, secret: string): Buffer {
  const message = [...params.entries()]
    .filter(([key]) => key !== 'hmac')
    .sort(([keyA, valueA], [keyB, valueB]) => (keyA === keyB ? compare(valueA, valueB) : compare(keyA, keyB)))
    .map(([key, value]) => `${key}=${value}`)
    .join('&');
  return createHmac('sha256', secret).update(message).digest();
}

// Verifies the hmac parameter of an OAuth callback or app URL query in constant time.
export function verifyOAuthQueryHmac(rawQuery: string, secret: string): boolean {
  const params = new URLSearchParams(rawQuery);
  const provided = params.get('hmac');
  if (provided === null || !/^[0-9a-fA-F]{64}$/.test(provided)) return false;
  return timingSafeEqual(Buffer.from(provided, 'hex'), oauthQueryDigest(params, secret));
}
