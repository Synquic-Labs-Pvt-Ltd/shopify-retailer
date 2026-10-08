import { defineConfig } from '@playwright/test';

const port = 3100;

// Smoke tests run against a production build in mock mode: no Shopify, no backend. NEXT_PUBLIC_MOCK is inlined
// at build time, so the server command builds with it. One worker and the Edge that Windows already ships keep
// memory low. The Polaris web components still load from Shopify's CDN, so the tests need internet access.
export default defineConfig({
  testDir: './e2e',
  timeout: 60_000,
  workers: 1,
  fullyParallel: false,
  reporter: 'list',
  use: {
    baseURL: `http://localhost:${port}`,
    channel: 'msedge',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'off',
    viewport: { width: 1280, height: 900 },
  },
  webServer: {
    command: `pnpm exec next build && pnpm exec next start -p ${port}`,
    env: { NEXT_PUBLIC_MOCK: '1', NEXT_TELEMETRY_DISABLED: '1' },
    url: `http://localhost:${port}/products`,
    reuseExistingServer: true,
    timeout: 300_000,
  },
});
