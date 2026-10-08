import path from 'node:path';
import type { NextConfig } from 'next';

// Next runs from apps/web (pnpm -F @rs/web ...), so the monorepo root is two levels up.
const repoRoot = path.resolve(process.cwd(), '../..');

// Forwarding to the backend (/api/v1, /auth/shopify/*, /webhooks/shopify) happens in proxy.ts, where BACKEND_URL
// is read at request time. Rewrites here would freeze the address at build time.
const config: NextConfig = {
  reactStrictMode: true,
  output: 'standalone',
  // @rs/shared and @rs/mock-api ship as TypeScript source.
  transpilePackages: ['@rs/shared', '@rs/mock-api'],
  turbopack: { root: repoRoot },
  outputFileTracingRoot: repoRoot,
  poweredByHeader: false,
};

export default config;
