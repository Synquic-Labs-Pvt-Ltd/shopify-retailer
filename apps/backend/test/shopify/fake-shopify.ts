import { createHmac } from 'node:crypto';
import { EXCHANGE_GRANT, checkExchangeRequest } from '../helpers/session-token';

// An in-memory Shopify for tests: the OAuth authorize/token endpoints and the Admin GraphQL shop query,
// all served through an injected fetch.

export interface FakeUser {
  id: number;
  first_name: string;
  last_name: string;
  email: string;
  account_owner: boolean;
  collaborator: boolean;
  locale: string;
}

export interface RecordedCall {
  url: string;
  method: string;
  form: Record<string, string> | null;
  headers: Record<string, string>;
}

interface PendingGrant {
  shop: string;
  online: boolean;
  scope: string;
  user: FakeUser | null;
}

export interface ApproveOptions {
  // Scopes Shopify reports as granted. Defaults to the scopes the app requested.
  scope?: string;
  user?: Partial<FakeUser>;
  // Extra callback parameters (host, locale, ...) that must take part in the HMAC.
  extra?: Record<string, string>;
}

// Knobs of the token exchange grant (App Bridge session token for an offline token).
export interface ExchangeKnobs {
  // Shops where the app is not installed: the exchange answers 400.
  refuse: Set<string>;
  // Answer every exchange with this HTTP status (for example 503) instead of looking at the request.
  forceStatus: number | null;
  // Time the token endpoint takes to answer an exchange, to make concurrent requests overlap.
  delayMs: number;
  // Scopes reported by the exchange response.
  scope: string;
}

export interface FakeShopify {
  fetchImpl: typeof fetch;
  exchange: ExchangeKnobs;
  // The recorded token-exchange requests.
  exchangeCalls(): RecordedCall[];
  calls: RecordedCall[];
  shopInfo: { id: string; name: string; email: string; currencyCode: string; ianaTimezone: string };
  failShopQuery: boolean;
  // Simulates the merchant approving an authorize URL; returns the callback path and query Shopify redirects to.
  approve(authorizeUrl: string, options?: ApproveOptions): string;
  latestRefreshToken(shop: string): string | undefined;
}

export const DEFAULT_USER: FakeUser = {
  id: 902541635,
  first_name: 'Asha',
  last_name: 'Verma',
  email: 'asha@example.com',
  account_owner: true,
  collaborator: false,
  locale: 'en',
};

// Independent of the implementation under test: sorted key=value pairs joined by "&", hex HMAC-SHA256.
export function signQuery(params: Record<string, string>, secret: string): string {
  const message = Object.entries(params)
    .filter(([key]) => key !== 'hmac')
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([key, value]) => `${key}=${value}`)
    .join('&');
  return createHmac('sha256', secret).update(message).digest('hex');
}

export function signedQueryString(params: Record<string, string>, secret: string): string {
  return new URLSearchParams({ ...params, hmac: signQuery(params, secret) }).toString();
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

export function createFakeShopify(options: { apiKey: string; apiSecret: string; apiVersion: string; now?: () => Date }): FakeShopify {
  const calls: RecordedCall[] = [];
  const pending = new Map<string, PendingGrant>();
  const refreshTokens = new Map<string, string>();
  const accessTokens = new Set<string>();
  let counter = 0;

  const fake: FakeShopify = {
    calls,
    shopInfo: { id: 'gid://shopify/Shop/1001', name: 'Demo Store', email: 'owner@demo.example', currencyCode: 'INR', ianaTimezone: 'Asia/Kolkata' },
    failShopQuery: false,
    exchange: { refuse: new Set(), forceStatus: null, delayMs: 0, scope: 'read_products,read_files,write_files' },
    exchangeCalls: () => calls.filter((call) => call.form?.grant_type === EXCHANGE_GRANT),
    latestRefreshToken: (shop) => refreshTokens.get(shop),

    approve(authorizeUrl, approveOptions = {}) {
      const url = new URL(authorizeUrl);
      if (url.searchParams.get('client_id') !== options.apiKey) throw new Error('authorize URL has the wrong client_id');
      const state = url.searchParams.get('state');
      const redirectUri = url.searchParams.get('redirect_uri');
      if (state === null || redirectUri === null) throw new Error('authorize URL is missing state or redirect_uri');

      const online = url.searchParams.getAll('grant_options[]').includes('per-user');
      const code = `code_${++counter}`;
      pending.set(code, {
        shop: url.hostname,
        online,
        scope: approveOptions.scope ?? url.searchParams.get('scope') ?? '',
        user: online ? { ...DEFAULT_USER, ...approveOptions.user } : null,
      });

      const params = { code, shop: url.hostname, state, timestamp: '1760000000', host: 'YWRtaW4', ...approveOptions.extra };
      const target = new URL(redirectUri);
      return `${target.pathname}?${signedQueryString(params, options.apiSecret)}`;
    },

    fetchImpl: (input, init) => {
      const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
      const headers = Object.fromEntries(new Headers(init?.headers).entries());
      const body = init?.body;
      const form = body instanceof URLSearchParams ? Object.fromEntries(body.entries()) : null;
      calls.push({ url: url.href, method: init?.method ?? 'GET', form, headers });

      if (url.pathname === '/admin/oauth/access_token') return tokenEndpoint(url.hostname, form ?? {});
      if (url.pathname === `/admin/api/${options.apiVersion}/graphql.json`) {
        return Promise.resolve(graphql(headers['x-shopify-access-token']));
      }
      return Promise.resolve(json(404, {}));
    },
  };

  async function tokenExchange(shop: string, form: Record<string, string>): Promise<Response> {
    if (fake.exchange.delayMs > 0) await new Promise((resolve) => setTimeout(resolve, fake.exchange.delayMs));
    if (fake.exchange.forceStatus !== null) return json(fake.exchange.forceStatus, { error: 'forced' });
    if (fake.exchange.refuse.has(shop)) return json(400, { error: 'invalid_request', error_description: 'The app is not installed on this shop' });
    const problem = await checkExchangeRequest(form, { shop, apiKey: options.apiKey, apiSecret: options.apiSecret, now: options.now });
    if (problem !== null) return json(400, { error: 'invalid_request', error_description: problem });
    return json(200, issueOffline(shop, fake.exchange.scope));
  }

  async function tokenEndpoint(shop: string, form: Record<string, string>): Promise<Response> {
    if (form.grant_type === EXCHANGE_GRANT) return tokenExchange(shop, form);
    if (form.client_id !== options.apiKey || form.client_secret !== options.apiSecret) {
      return json(400, { error: 'invalid_client' });
    }

    if (form.grant_type === 'refresh_token') {
      if (form.refresh_token === undefined || refreshTokens.get(shop) !== form.refresh_token) {
        return json(401, { error: 'invalid_request', error_description: 'This request requires an active refresh_token' });
      }
      return json(200, issueOffline(shop));
    }

    const grant = form.code === undefined ? undefined : pending.get(form.code);
    if (form.code === undefined || grant === undefined || grant.shop !== shop) {
      return json(400, { error: 'invalid_request', error_description: 'The authorization code was not found or was already used' });
    }
    pending.delete(form.code);

    if (grant.online) {
      const accessToken = `shpat_online_${++counter}`;
      return json(200, {
        access_token: accessToken,
        scope: grant.scope,
        expires_in: 86399,
        associated_user_scope: grant.scope,
        associated_user: grant.user,
      });
    }
    return json(200, form.expiring === '1' ? issueOffline(shop, grant.scope) : { access_token: issueAccess(), scope: grant.scope });
  }

  function issueAccess(): string {
    const token = `shpat_offline_${++counter}`;
    accessTokens.add(token);
    return token;
  }

  function issueOffline(shop: string, scope?: string): Record<string, unknown> {
    const refreshToken = `shprt_${++counter}`;
    refreshTokens.set(shop, refreshToken);
    return {
      access_token: issueAccess(),
      ...(scope === undefined ? {} : { scope }),
      expires_in: 3600,
      refresh_token: refreshToken,
      refresh_token_expires_in: 7_776_000,
    };
  }

  function graphql(token: string | undefined): Response {
    if (token === undefined || !accessTokens.has(token)) return json(401, { errors: 'Invalid API key or access token' });
    if (fake.failShopQuery) return json(500, {});
    return json(200, { data: { shop: fake.shopInfo } });
  }

  return fake;
}
