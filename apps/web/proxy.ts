import { NextResponse, type NextRequest } from 'next/server';
import { backendTarget } from '@/lib/backend-route';

// Shopify requires every HTML response to be frameable only by the shop's own admin (SPEC 27).
// The shop comes from the `shop` query parameter that the admin adds to the iframe URL. A wildcard
// source is not accepted by Shopify's app review, so the value is built per request.
const SHOP_PATTERN = /^[a-z0-9][a-z0-9-]*\.myshopify\.com$/;
const ADMIN_HOSTS = 'https://admin.shopify.com https://*.spin.dev https://admin.myshopify.io https://admin.shop.dev';

export function proxy(request: NextRequest): NextResponse {
  const { pathname, search, searchParams } = request.nextUrl;

  // /api/v1, /auth/shopify/* and /webhooks/shopify go to the backend, whose address is read now (runtime),
  // so the same build serves any deployment. The body and headers pass through unchanged (webhook HMACs).
  const target = backendTarget(pathname, search, {
    backendUrl: process.env.BACKEND_URL,
    mock: process.env.NEXT_PUBLIC_MOCK === '1',
  });
  if (target.kind === 'rewrite') return NextResponse.rewrite(target.url);
  if (target.kind === 'misconfigured') {
    return NextResponse.json({ error: { code: 'internal', message: 'The web app has no valid BACKEND_URL configured.' } }, { status: 502 });
  }

  // Route handlers of this app (health, download, the mock API): no framing header needed.
  if (pathname.startsWith('/api/')) return NextResponse.next();

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

// Everything except static assets: documents get the framing header, the forwarded paths are proxied.
export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
};
