import path from 'node:path';
import type { NextConfig } from 'next';

// Next runs from apps/web (pnpm -F @rs/web ...), so the monorepo root is two levels up.
const repoRoot = path.resolve(process.cwd(), '../..');
const backendUrl = (process.env.BACKEND_URL ?? 'http://localhost:3000').replace(/\/+$/, '');
const mock = process.env.NEXT_PUBLIC_MOCK === '1';

const config: NextConfig = {
  reactStrictMode: true,
  output: 'standalone',
  // @rs/shared and @rs/mock-api ship as TypeScript source.
  transpilePackages: ['@rs/shared', '@rs/mock-api'],
  turbopack: { root: repoRoot },
  outputFileTracingRoot: repoRoot,
  poweredByHeader: false,
  async rewrites() {
    // One public origin for Shopify: the web app also serves the OAuth redirect and the webhooks by
    // forwarding them to the backend. In mock mode /api/v1 is served by a route handler instead.
    return {
      beforeFiles: [
        ...(mock ? [] : [{ source: '/api/v1/:path*', destination: `${backendUrl}/api/v1/:path*` }]),
        { source: '/auth/shopify/:path*', destination: `${backendUrl}/auth/shopify/:path*` },
        { source: '/webhooks/shopify', destination: `${backendUrl}/webhooks/shopify` },
      ],
      afterFiles: [],
      fallback: [],
    };
  },
};

export default config;
