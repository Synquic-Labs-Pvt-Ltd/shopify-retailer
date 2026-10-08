import { describe, expect, it } from 'vitest';
import { backendTarget, isBackendPath } from './backend-route';

const env = { backendUrl: 'http://backend.internal:3000', mock: false };

describe('isBackendPath', () => {
  it('matches the three forwarded prefixes on a segment boundary only', () => {
    for (const path of ['/api/v1', '/api/v1/me', '/auth/shopify/start', '/auth/shopify/callback', '/webhooks/shopify']) {
      expect(isBackendPath(path)).toBe(true);
    }
    for (const path of ['/', '/products', '/api/download', '/api/health', '/api/v10/me', '/auth/shopifyx', '/webhooks/shopify2', '/x/api/v1']) {
      expect(isBackendPath(path)).toBe(false);
    }
  });
});

describe('backendTarget', () => {
  it('rewrites forwarded paths to the backend origin and keeps the query string', () => {
    const target = backendTarget('/api/v1/products', '?q=lamp&limit=20', env);
    expect(target).toEqual({ kind: 'rewrite', url: new URL('http://backend.internal:3000/api/v1/products?q=lamp&limit=20') });
  });

  it('leaves the app own paths alone', () => {
    expect(backendTarget('/generations', '', env)).toEqual({ kind: 'none' });
    expect(backendTarget('/api/download', '?url=x', env)).toEqual({ kind: 'none' });
  });

  it('serves /api/v1 locally in mock mode but still forwards the Shopify callbacks', () => {
    const mock = { backendUrl: undefined, mock: true };
    expect(backendTarget('/api/v1/me', '', mock)).toEqual({ kind: 'none' });
    expect(backendTarget('/webhooks/shopify', '', { ...mock, backendUrl: env.backendUrl }).kind).toBe('rewrite');
  });

  it('reports a missing or invalid BACKEND_URL instead of guessing', () => {
    for (const backendUrl of [undefined, '', '   ', 'not a url', 'ftp://backend', 'javascript:alert(1)']) {
      expect(backendTarget('/api/v1/me', '', { backendUrl, mock: false })).toEqual({ kind: 'misconfigured' });
    }
  });

  it('uses only the origin of BACKEND_URL', () => {
    const target = backendTarget('/auth/shopify/start', '?shop=x.myshopify.com', { backendUrl: 'https://api.example.com/some/base/', mock: false });
    expect(target.kind === 'rewrite' && target.url.href).toBe('https://api.example.com/auth/shopify/start?shop=x.myshopify.com');
  });

  it('never leaves the backend origin, whatever the path looks like', () => {
    for (const path of ['/api/v1//evil.example/x', '/api/v1/%2e%2e/%2e%2e/x', '/api/v1\\@evil.example', '/api/v1/..//evil.example']) {
      // Either forwarded to the backend origin or not forwarded at all, never to another host.
      const target = backendTarget(path, '', env);
      expect(['rewrite', 'none']).toContain(target.kind);
      if (target.kind === 'rewrite') expect(target.url.origin).toBe('http://backend.internal:3000');
    }
  });
});
