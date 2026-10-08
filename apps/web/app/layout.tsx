import type { Metadata } from 'next';
import Script from 'next/script';
import type { ReactNode } from 'react';
import { Providers } from './providers';

export const metadata: Metadata = {
  title: 'Retailer Studio',
  description: 'AI lifestyle images and videos for your Shopify products.',
};

const apiKey = process.env.NEXT_PUBLIC_SHOPIFY_API_KEY ?? '';
const polarisUrl = process.env.NEXT_PUBLIC_POLARIS_URL ?? 'https://cdn.shopify.com/shopifycloud/polaris-1.js';
const mock = process.env.NEXT_PUBLIC_MOCK === '1';

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <head>
        <meta name="shopify-api-key" content={apiKey} />
        <link rel="preconnect" href="https://cdn.shopify.com/" />
        <link rel="stylesheet" href="https://cdn.shopify.com/static/fonts/inter/v4/styles.css" />
      </head>
      <body>
        {/* App Bridge only works inside the Shopify admin; mock mode runs in a plain tab without it. */}
        {mock ? null : <Script src="https://cdn.shopify.com/shopifycloud/app-bridge.js" data-api-key={apiKey} strategy="beforeInteractive" />}
        <Script src={polarisUrl} strategy="beforeInteractive" />
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
