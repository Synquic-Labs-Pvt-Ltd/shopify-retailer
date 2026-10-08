'use client';

import type { ReactNode } from 'react';
import { generateHint, outputsLabel, outputTotals, readyProductsLabel, type SlotCounts } from './logic';

interface SummaryAsideProps {
  productCount: number;
  // From /me; undefined until it has loaded.
  imagesPerProduct: number | undefined;
  videosPerProduct: number | undefined;
  readyProducts: number;
  counts: SlotCounts;
}

function Line({ label, children }: { label: string; children: ReactNode }) {
  return (
    <s-grid gridTemplateColumns="1fr auto" gap="base">
      <s-text color="subdued">{label}</s-text>
      <s-text type="strong">{children}</s-text>
    </s-grid>
  );
}

// The aside of the page: what the batch will produce and how far the references are.
export function SummaryAside({ productCount, imagesPerProduct, videosPerProduct, readyProducts, counts }: SummaryAsideProps) {
  const settings = imagesPerProduct !== undefined && videosPerProduct !== undefined;
  const hint = generateHint(counts);

  return (
    <>
      <s-section slot="aside" heading="Summary">
        <s-stack gap="small">
          <Line label="Products">{productCount}</Line>
          <Line label="Images per product">{imagesPerProduct ?? '-'}</Line>
          <Line label="Videos per product">{videosPerProduct ?? '-'}</Line>
          <s-divider />
          <Line label="Outputs">
            {settings ? outputsLabel(outputTotals(productCount, imagesPerProduct, videosPerProduct)) : '-'}
          </Line>
        </s-stack>
      </s-section>
      <s-section slot="aside" heading="References">
        <s-stack gap="small">
          <s-paragraph color="subdued">
            A product always follows its Shopify photos and the photos you add for it. Style references only set the look.
            With neither added, a product cannot be generated.
          </s-paragraph>
          <Line label="Ready">{readyProductsLabel(readyProducts, productCount)}</Line>
          {hint !== null ? <s-text tone="warning">{hint}</s-text> : null}
        </s-stack>
      </s-section>
    </>
  );
}
