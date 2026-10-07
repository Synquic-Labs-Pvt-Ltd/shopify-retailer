import { createHmac, timingSafeEqual } from 'node:crypto';

// X-Shopify-Hmac-Sha256 is the base64 HMAC-SHA256 of the raw request body, keyed with the app secret.
export function verifyWebhookHmac(rawBody: Buffer, headerValue: string, secret: string): boolean {
  const expected = createHmac('sha256', secret).update(rawBody).digest();
  const provided = Buffer.from(headerValue, 'base64');
  return provided.length === expected.length && timingSafeEqual(provided, expected);
}
