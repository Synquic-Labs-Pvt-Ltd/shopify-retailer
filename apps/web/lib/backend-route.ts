// Which requests the web origin forwards to the backend. Shopify knows one public origin for the app, so the OAuth
// redirect and the webhooks arrive here too. The backend address is read at request time (not at build time), so one
// built image works with any BACKEND_URL.
export const BACKEND_PREFIXES = ['/api/v1', '/auth/shopify', '/webhooks/shopify'] as const;

export type BackendTarget =
  // Handled by this app (pages, route handlers, the mock API).
  | { kind: 'none' }
  | { kind: 'rewrite'; url: URL }
  // A forwarded path, but BACKEND_URL is missing or not an http(s) URL.
  | { kind: 'misconfigured' };

export interface BackendRouteEnv {
  backendUrl: string | undefined;
  // NEXT_PUBLIC_MOCK=1: /api/v1 is served by this app's mock route handler.
  mock: boolean;
}

function isUnder(pathname: string, prefix: string): boolean {
  return pathname === prefix || pathname.startsWith(`${prefix}/`);
}

export function isBackendPath(pathname: string): boolean {
  return BACKEND_PREFIXES.some((prefix) => isUnder(pathname, prefix));
}

// Only the origin of BACKEND_URL is used: the backend is mounted at its root.
function parseOrigin(value: string | undefined): string | null {
  if (value === undefined || value.trim() === '') return null;
  try {
    const url = new URL(value.trim());
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.origin : null;
  } catch {
    return null;
  }
}

export function backendTarget(pathname: string, search: string, env: BackendRouteEnv): BackendTarget {
  if (!isBackendPath(pathname)) return { kind: 'none' };
  if (env.mock && isUnder(pathname, '/api/v1')) return { kind: 'none' };
  const origin = parseOrigin(env.backendUrl);
  if (origin === null) return { kind: 'misconfigured' };
  // The path always starts with one of the prefixes, so the result cannot leave the backend origin.
  return { kind: 'rewrite', url: new URL(`${pathname}${search}`, origin) };
}
