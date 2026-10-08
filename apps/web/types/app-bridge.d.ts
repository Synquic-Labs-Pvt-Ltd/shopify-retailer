import type { DetailedHTMLProps, HTMLAttributes } from 'react';

// Custom elements provided by App Bridge (https://cdn.shopify.com/shopifycloud/app-bridge.js) rather than by the
// Polaris web components, so @shopify/polaris-types does not declare them.
declare module 'react' {
  namespace JSX {
    interface IntrinsicElements {
      's-app-nav': DetailedHTMLProps<HTMLAttributes<HTMLElement>, HTMLElement>;
    }
  }
}
