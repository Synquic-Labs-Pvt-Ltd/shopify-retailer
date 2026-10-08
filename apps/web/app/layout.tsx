import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import { Providers } from './providers';

export const metadata: Metadata = {
  title: 'Retailer Studio',
  description: 'AI lifestyle images and videos for your Shopify products.',
};

// Rendered per request so the Shopify client id and the Polaris script URL come from the runtime environment
// (one built image, any deployment). The client id is public: App Bridge needs it in the page.
export const dynamic = 'force-dynamic';

const DEFAULT_POLARIS_URL = 'https://cdn.shopify.com/shopifycloud/polaris-1.js';

export default function RootLayout({ children }: { children: ReactNode }) {
  const apiKey = process.env.SHOPIFY_API_KEY ?? process.env.NEXT_PUBLIC_SHOPIFY_API_KEY ?? '';
  const polarisUrl = process.env.POLARIS_URL ?? process.env.NEXT_PUBLIC_POLARIS_URL ?? DEFAULT_POLARIS_URL;
  const mock = process.env.NEXT_PUBLIC_MOCK === '1';

  return (
    <html lang="en">
      <head>
        {/* Shopify requires App Bridge as a plain synchronous script at the top of the page, before any other script
            (not next/script, which injects it dynamically after the app has started). Polaris follows it. Mock mode runs
            in a plain tab without App Bridge. */}
        {mock ? null : <script src="https://cdn.shopify.com/shopifycloud/app-bridge.js" data-api-key={apiKey} />}
        <script src={polarisUrl} />
        <meta name="shopify-api-key" content={apiKey} />
        <link rel="preconnect" href="https://cdn.shopify.com/" />
        <link rel="stylesheet" href="https://cdn.shopify.com/static/fonts/inter/v4/styles.css" />
      </head>
      <body>
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
