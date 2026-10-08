import { describe, expect, it } from 'vitest';
import { MAX_DOWNLOAD_BYTES, isAllowedDownloadHost, limitBytes, parseDownloadUrl, sanitizeFilename } from './download-policy';

const ALLOWED: [string, string][] = [
  ['the Shopify CDN', 'https://cdn.shopify.com/s/files/1/0001/0002/files/image.jpg?v=1712345678'],
  ['a path with a fragment', 'https://cdn.shopify.com/videos/c/vp/abc/abc.HD-1080p-7.2Mbps.mp4#t=1'],
  ['an uppercase host', 'https://CDN.SHOPIFY.COM/s/files/x.jpg'],
  ['a mixed case host', 'https://Cdn.Shopify.Com/x.jpg'],
  ['the default https port written out', 'https://cdn.shopify.com:443/x.jpg'],
  ['a shopifycdn.com subdomain', 'https://shop.shopifycdn.com/x.jpg'],
  ['a nested shopifycdn.com subdomain', 'https://a.b.shopifycdn.com/x.jpg'],
  ['an uppercase shopifycdn.com subdomain', 'https://SHOP.SHOPIFYCDN.COM/x.jpg'],
  ['a percent-encoded dot that still resolves to the CDN', 'https://cdn%2Eshopify.com/x.jpg'],
  ['a backslash that the URL parser reads as a path slash', 'https://cdn.shopify.com\\@evil.test/x.jpg'],
];

const REJECTED: [string, string][] = [
  ['plain http', 'http://cdn.shopify.com/x.jpg'],
  ['another scheme', 'ftp://cdn.shopify.com/x.jpg'],
  ['a javascript url', 'javascript:alert(1)'],
  ['a data url', 'data:text/html,<script>alert(1)</script>'],
  ['a protocol relative url', '//cdn.shopify.com/x.jpg'],
  ['no scheme', 'cdn.shopify.com/x.jpg'],
  ['an empty string', ''],
  ['text that is not a url', 'not a url'],
  ['a scheme without a host', 'https://'],
  ['userinfo that names the CDN in front of another host', 'https://cdn.shopify.com@evil.test/x.jpg'],
  ['userinfo with a password in front of another host', 'https://cdn.shopify.com:secret@evil.test/x.jpg'],
  ['userinfo in front of the real CDN host', 'https://evil.test@cdn.shopify.com/x.jpg'],
  ['an encoded at sign in the host', 'https://cdn.shopify.com%40evil.test/x.jpg'],
  ['a backslash before the real host', 'https://evil.test\\@cdn.shopify.com/x.jpg'],
  ['the CDN as a prefix of another domain', 'https://cdn.shopify.com.evil.test/x.jpg'],
  ['the CDN as a subdomain of another domain', 'https://cdn.shopify.com.evil.com/x.jpg'],
  ['a trailing dot on the host', 'https://cdn.shopify.com./x.jpg'],
  ['a sibling subdomain of shopify.com', 'https://evil.shopify.com/x.jpg'],
  ['a prefixed subdomain of cdn.shopify.com', 'https://evil.cdn.shopify.com/x.jpg'],
  ['a lookalike with a dash', 'https://cdn-shopify.com/x.jpg'],
  ['a lookalike glued to the name', 'https://notcdn.shopify.com/x.jpg'],
  ['a domain that only ends with the CDN suffix text', 'https://evilshopifycdn.com/x.jpg'],
  ['the bare shopifycdn.com domain', 'https://shopifycdn.com/x.jpg'],
  ['shopifycdn.com as a prefix of another domain', 'https://x.shopifycdn.com.evil.test/x.jpg'],
  ['a Cyrillic lookalike letter', 'https://cdn.shopif\u0443.com/x.jpg'],
  ['a non default port', 'https://cdn.shopify.com:8443/x.jpg'],
  ['port 80 on https', 'https://cdn.shopify.com:80/x.jpg'],
  ['a non default port on a shopifycdn.com host', 'https://shop.shopifycdn.com:444/x.jpg'],
  ['an IPv4 literal', 'https://127.0.0.1/x.jpg'],
  ['the cloud metadata address', 'https://169.254.169.254/latest/meta-data'],
  ['an IPv6 literal', 'https://[::1]/x.jpg'],
  ['an IPv4 mapped IPv6 literal', 'https://[::ffff:127.0.0.1]/x.jpg'],
  ['an integer IPv4 literal', 'https://2130706433/x.jpg'],
  ['a hex IPv4 literal', 'https://0x7f.1/x.jpg'],
  ['localhost', 'https://localhost/x.jpg'],
  ['a leading space and another host', ' https://evil.test/x.jpg'],
];

describe('isAllowedDownloadHost', () => {
  it.each(ALLOWED)('allows %s', (_label, url) => {
    expect(isAllowedDownloadHost(url)).toBe(true);
  });

  it.each(REJECTED)('rejects %s', (_label, url) => {
    expect(isAllowedDownloadHost(url)).toBe(false);
  });
});

describe('parseDownloadUrl', () => {
  it('returns the normalised url so the check and the request see the same host', () => {
    expect(parseDownloadUrl('https://CDN.SHOPIFY.COM:443/a b.jpg')?.href).toBe('https://cdn.shopify.com/a%20b.jpg');
    expect(parseDownloadUrl('https://cdn.shopify.com\\@evil.test/x.jpg')?.hostname).toBe('cdn.shopify.com');
    expect(parseDownloadUrl('https://@cdn.shopify.com/x.jpg')?.href).toBe('https://cdn.shopify.com/x.jpg');
  });

  it('returns null for a rejected url', () => {
    expect(parseDownloadUrl('https://cdn.shopify.com@evil.test/')).toBeNull();
  });
});

describe('sanitizeFilename', () => {
  it.each([
    ['photo.jpg', 'photo.jpg'],
    ['rs-ceramic-lamp-a1b2c3-img1.jpg', 'rs-ceramic-lamp-a1b2c3-img1.jpg'],
    ['my photo (1).jpg', 'my_photo__1_.jpg'],
    ['../../etc/passwd', 'passwd'],
    ['C:\\Users\\me\\photo.png', 'photo.png'],
    ['.htaccess', 'htaccess'],
    ['...', 'download'],
    ['', 'download'],
    ['/', 'download'],
    ['a"b\r\nc.jpg', 'a_b__c.jpg'],
    ['caf\u00e9.jpg', 'caf_.jpg'],
    ['name.mp4?x=1', 'name.mp4_x_1'],
  ])('%j -> %j', (input, expected) => {
    expect(sanitizeFilename(input)).toBe(expected);
  });

  it('keeps the extension when it shortens a long name', () => {
    const result = sanitizeFilename(`${'a'.repeat(300)}.jpg`);
    expect(result).toHaveLength(120);
    expect(result.endsWith('.jpg')).toBe(true);
  });

  it('uses the given fallback for an empty name', () => {
    expect(sanitizeFilename('', 'file')).toBe('file');
  });
});

describe('limitBytes', () => {
  async function drain(stream: ReadableStream<Uint8Array>): Promise<number> {
    const reader = stream.getReader();
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return total;
      total += value.byteLength;
    }
  }

  function bodyOf(...sizes: number[]): ReadableStream<Uint8Array> {
    return new ReadableStream({
      start(controller) {
        for (const size of sizes) controller.enqueue(new Uint8Array(size));
        controller.close();
      },
    });
  }

  it('passes a body up to the limit', async () => {
    expect(await drain(bodyOf(40, 60).pipeThrough(limitBytes(100)))).toBe(100);
  });

  it('errors once the limit is crossed', async () => {
    await expect(drain(bodyOf(40, 61).pipeThrough(limitBytes(100)))).rejects.toThrow('too large');
  });

  it('uses a 500 MB cap for downloads', () => {
    expect(MAX_DOWNLOAD_BYTES).toBe(524_288_000);
  });
});
