import { NextResponse, type NextRequest } from 'next/server';

// Shopify requires every HTML response to be frameable only by the shop's own admin (SPEC 26, web app).
// The shop comes from the `shop` query parameter that the admin adds to the iframe URL. A wildcard
// source is not accepted by Shopify's app review, so the value is built per request.
const SHOP_PATTERN = /^[a-z0-9][a-z0-9-]*\.myshopify\.com$/;
const ADMIN_HOSTS = 'https://admin.shopify.com https://*.spin.dev https://admin.myshopify.io https://admin.shop.dev';

export function proxy(request: NextRequest): NextResponse {
  const { pathname, search, searchParams } = request.nextUrl;

  // The app URL is `/`; keep the query string (shop, host, id_token) that App Bridge needs.
  if (pathname === '/') {
    return NextResponse.redirect(new URL(`/generations${search}`, request.url));
  }

  const response = NextResponse.next();
  const shop = searchParams.get('shop');
  if (shop !== null && SHOP_PATTERN.test(shop)) {
    response.headers.set('Content-Security-Policy', `frame-ancestors https://${shop} ${ADMIN_HOSTS};`);
  }
  return response;
}

// Documents only: API calls, Shopify callbacks and static assets are not framed.
export const config = {
  matcher: ['/((?!api|auth|webhooks|_next/static|_next/image|favicon.ico).*)'],
};
