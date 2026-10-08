'use client';

import { useEffect, useState } from 'react';
import { adminAppUrl, readShopParam } from '@/lib/shopify';

// Shown when the app is opened in a plain browser tab instead of inside the Shopify admin. Sign-in needs App Bridge,
// which only exists inside the admin, so there is nothing to do here except send the merchant back into it.
export function OutsideAdmin() {
  const [adminUrl, setAdminUrl] = useState<string | null>(null);

  useEffect(() => {
    const shop = readShopParam(window.location.search);
    const apiKey = document.querySelector('meta[name="shopify-api-key"]')?.getAttribute('content') ?? '';
    setAdminUrl(shop !== null && apiKey !== '' ? adminAppUrl(shop, apiKey) : null);
  }, []);

  return (
    <s-page heading="Retailer Studio">
      <s-section>
        <s-stack gap="base">
          <s-heading>Open Retailer Studio from your Shopify admin</s-heading>
          <s-paragraph>This app runs inside the Shopify admin and cannot sign you in from a separate browser tab.</s-paragraph>
          {adminUrl === null ? (
            <s-paragraph>In your store admin, open Apps, then Retailer Studio.</s-paragraph>
          ) : (
            <s-button variant="primary" href={adminUrl} target="_top">
              Open in Shopify admin
            </s-button>
          )}
        </s-stack>
      </s-section>
    </s-page>
  );
}
