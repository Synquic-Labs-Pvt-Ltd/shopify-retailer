import { z } from 'zod';
import { FAKE_JPEG } from '../../../src/modules/ai/fake-media';
import { checkExchangeRequest, EXCHANGE_GRANT } from '../../helpers/session-token';
import { DEFAULT_USER, signedQueryString, type FakeUser } from '../../shopify/fake-shopify';
import { productDetail, productImageUrl, productList, productSnapshots } from './stub-catalog';
import { fileCreate, fileDelete, fileStatus, stagedUploadsCreate } from './stub-files';
import { graphqlData, graphqlError, graphqlThrottled, jsonResponse, requestUrl } from './stub-http';
import { createStubState, type StubProduct, type StubShop, type StubState } from './stub-state';

// An in-memory Shopify plus CDN, served through the global fetch of the backend: the OAuth token endpoint,
// the Admin GraphQL API, the staged upload targets and the CDN. Requests to any other host are recorded in
// state.unexpected and fail, so a test can never reach the real network.

export interface ApproveOptions {
  user?: Partial<FakeUser>;
  scope?: string;
  // Extra callback parameters (host, locale, ...) that take part in the HMAC.
  extra?: Record<string, string>;
}

export interface ProductSeed {
  title: string;
  handle: string;
  vendor?: string;
  productType?: string;
  images?: number;
  descriptionHtml?: string;
}

export interface ShopifyStub {
  readonly fetch: typeof fetch;
  readonly state: StubState;
  addShop(domain: string, seeds?: ProductSeed[]): StubShop;
  shop(domain: string): StubShop;
  // The merchant approves an authorize URL. Returns the path and signed query of the callback redirect.
  approve(authorizeUrl: string, options?: ApproveOptions): string;
  // Drops every token of the shop, like an uninstall on Shopify's side.
  revokeTokens(domain: string): void;
  // The merchant uninstalls the app: every token is dropped and token exchanges are refused (400) until reinstall().
  uninstallApp(domain: string): void;
  // The merchant installs the app again: token exchanges work.
  reinstallApp(domain: string): void;
  graphqlOperations(shop?: string): string[];
}

export const DEFAULT_PRODUCTS: ProductSeed[] = [
  { title: 'Ceramic Table Lamp', handle: 'ceramic-table-lamp', vendor: 'Atelier Nord', productType: 'Lighting', images: 6, descriptionHtml: '<p>Hand <b>glazed</b> lamp.</p><ul><li>Linen shade</li></ul>' },
  { title: 'Linen Throw Pillow', handle: 'linen-throw-pillow', vendor: 'Atelier Nord', productType: 'Textiles', images: 2 },
  { title: 'Oak Side Table', handle: 'oak-side-table', vendor: 'Timberline', productType: 'Furniture', images: 3 },
  { title: 'Brass Desk Lamp', handle: 'brass-desk-lamp', vendor: 'Timberline', productType: 'Lighting', images: 2 },
  { title: 'Wool Blanket', handle: 'wool-blanket', vendor: 'Atelier Nord', productType: 'Textiles', images: 1 },
];

const graphqlBody = z.object({ query: z.string(), variables: z.record(z.string(), z.unknown()).nullish() });

interface Options {
  apiKey: string;
  apiSecret: string;
  apiVersion: string;
  redirectUri: string;
  // Scopes the token exchange reports. Default: the scopes the app asks for.
  scopes?: string;
}

const DEFAULT_SCOPES = 'read_products,read_files,write_files';

interface PendingGrant {
  shop: string;
  online: boolean;
  scope: string;
  user: FakeUser | null;
}

export function createShopifyStub(options: Options): ShopifyStub {
  const state = createStubState();
  const pending = new Map<string, PendingGrant>();

  const shopByDomain = (domain: string): StubShop => {
    const shop = state.shops.get(domain);
    if (shop === undefined) throw new Error(`The stub has no shop ${domain}`);
    return shop;
  };

  const mintToken = (kind: 'offline' | 'online'): string => `shpat_${kind}_${++state.counter}`;

  function issueOffline(shop: StubShop, scope: string | undefined): Record<string, unknown> {
    const accessToken = mintToken('offline');
    const refreshToken = `shprt_${++state.counter}`;
    shop.offlineTokens.add(accessToken);
    shop.refreshToken = refreshToken;
    return {
      access_token: accessToken,
      ...(scope === undefined ? {} : { scope }),
      expires_in: 3600,
      refresh_token: refreshToken,
      refresh_token_expires_in: 7_776_000,
    };
  }

  // An App Bridge session token traded for an expiring offline token (managed installation).
  async function tokenExchange(shop: StubShop, form: Record<string, string>): Promise<Response> {
    const base = { kind: 'token' as const, shop: shop.domain, grant: 'token_exchange' as const, expiring: form.expiring === '1' };
    if (state.knobs.exchangeDelayMs > 0) await new Promise((resolve) => setTimeout(resolve, state.knobs.exchangeDelayMs));
    const problem = state.knobs.refuseExchange.has(shop.domain)
      ? 'The app is not installed on this shop'
      : await checkExchangeRequest(form, { shop: shop.domain, apiKey: options.apiKey, apiSecret: options.apiSecret });
    if (problem !== null) {
      state.calls.push({ ...base, status: 400 });
      return jsonResponse(400, { error: 'invalid_request', error_description: problem });
    }
    state.calls.push({ ...base, status: 200 });
    return jsonResponse(200, issueOffline(shop, options.scopes ?? DEFAULT_SCOPES));
  }

  function tokenEndpoint(shop: StubShop, form: Record<string, string>): Response {
    const base = { kind: 'token' as const, shop: shop.domain };
    const expiring = form.expiring === '1';
    if (form.client_id !== options.apiKey || form.client_secret !== options.apiSecret) {
      state.calls.push({ ...base, grant: 'authorization_code', expiring, status: 400 });
      return jsonResponse(400, { error: 'invalid_client' });
    }

    if (form.grant_type === 'refresh_token') {
      const valid = !state.knobs.rejectRefresh.has(shop.domain) && shop.refreshToken !== null && form.refresh_token === shop.refreshToken;
      state.calls.push({ ...base, grant: 'refresh_token', expiring: false, status: valid ? 200 : 401 });
      if (!valid) return jsonResponse(401, { error: 'invalid_request', error_description: 'This request requires an active refresh_token' });
      return jsonResponse(200, issueOffline(shop, undefined));
    }

    const grant = form.code === undefined ? undefined : pending.get(form.code);
    if (form.code === undefined || grant === undefined || grant.shop !== shop.domain) {
      state.calls.push({ ...base, grant: 'authorization_code', expiring, status: 400 });
      return jsonResponse(400, { error: 'invalid_request', error_description: 'The authorization code was not found or was already used' });
    }
    pending.delete(form.code);
    state.calls.push({ ...base, grant: 'authorization_code', expiring, status: 200 });

    if (grant.online) {
      const accessToken = mintToken('online');
      shop.onlineTokens.add(accessToken);
      return jsonResponse(200, {
        access_token: accessToken,
        scope: grant.scope,
        expires_in: 86399,
        associated_user_scope: grant.scope,
        associated_user: grant.user,
      });
    }
    if (expiring) return jsonResponse(200, issueOffline(shop, grant.scope));
    const accessToken = mintToken('offline');
    shop.offlineTokens.add(accessToken);
    return jsonResponse(200, { access_token: accessToken, scope: grant.scope });
  }

  function graphql(shop: StubShop, headers: Headers, rawBody: string): Response {
    const token = headers.get('x-shopify-access-token') ?? undefined;
    const body = graphqlBody.parse(JSON.parse(rawBody));
    const query = body.query;
    const operation = /^\s*(?:query|mutation)\s+(\w+)/.exec(query)?.[1] ?? (/\bshop\s*\{/.test(query) ? 'ShopInfo' : 'Unknown');
    const variables = body.variables ?? {};
    state.calls.push({ kind: 'graphql', shop: shop.domain, operation, variables, token });

    if (token === undefined || !shop.offlineTokens.has(token)) {
      return jsonResponse(401, { errors: '[API] Invalid API key or access token (unrecognized login or wrong password)' });
    }
    const { httpFailure, throttle } = state.knobs;
    if (httpFailure !== null && httpFailure.operation === operation && httpFailure.remaining > 0) {
      httpFailure.remaining -= 1;
      return jsonResponse(httpFailure.status, { errors: 'The stub is failing on purpose' });
    }
    if (throttle !== null && throttle.operation === operation && throttle.remaining > 0) {
      throttle.remaining -= 1;
      return graphqlThrottled();
    }

    switch (operation) {
      case 'ShopInfo':
        return state.knobs.failShopQuery ? jsonResponse(500, {}) : graphqlData({ shop: shop.info });
      case 'ProductList':
        return productList(shop, variables);
      case 'ProductDetail':
        return productDetail(shop, query, variables);
      case 'ProductSnapshots':
        return productSnapshots(shop, query, variables);
      case 'StagedUploadsCreate':
        return stagedUploadsCreate(state, shop, variables);
      case 'FileCreate':
        return fileCreate(state, shop, variables);
      case 'FileStatus':
        return fileStatus(state, shop, variables);
      case 'FileDelete':
        return fileDelete(state, shop, variables);
      default:
        return graphqlError(`The stub does not implement the operation "${operation}"`);
    }
  }

  // The staged target accepts what Google Cloud Storage accepts: every issued parameter, the file last.
  function stagedUpload(url: URL, form: FormData): Promise<Response> {
    const entries = [...form.entries()];
    const keyEntry = entries.find(([name]) => name === 'key');
    const key = typeof keyEntry?.[1] === 'string' ? keyEntry[1] : undefined;
    const owner = [...state.shops.values()].find((shop) => key !== undefined && shop.stagedByKey.has(key));
    const target = key === undefined ? undefined : owner?.stagedByKey.get(key);
    const file = entries[entries.length - 1];
    const reject = (reason: string): Response => {
      state.unexpected.push(`staged upload rejected: ${reason}`);
      return new Response(`<Error><Code>AccessDenied</Code><Message>${reason}</Message></Error>`, { status: 403 });
    };

    if (owner === undefined || target === undefined) return Promise.resolve(reject('unknown key'));
    if (`${url.origin}/` !== target.url) return Promise.resolve(reject('wrong upload url'));
    for (const parameter of target.parameters) {
      if (!entries.some(([name, value]) => name === parameter.name && value === parameter.value)) {
        return Promise.resolve(reject(`missing parameter ${parameter.name}`));
      }
    }
    if (file === undefined || file[0] !== 'file' || typeof file[1] === 'string') return Promise.resolve(reject('the file must be the last field'));

    const blob = file[1];
    return blob.arrayBuffer().then((buffer) => {
      const bytes = new Uint8Array(buffer);
      target.received = { bytes, type: blob.type, filename: blob.name };
      state.calls.push({ kind: 'staged_upload', shop: owner.domain, key: target.key, filename: blob.name, size: bytes.byteLength, type: blob.type, status: 201 });
      return new Response('', { status: 201 });
    });
  }

  function cdn(url: URL): Response {
    const blocked = state.knobs.cdnNotFound.some((fragment) => url.href.includes(fragment));
    const object = blocked ? undefined : state.cdn.get(url.pathname);
    state.calls.push({ kind: 'cdn', url: url.href, status: object === undefined ? 404 : 200 });
    if (object === undefined) return new Response('Not Found', { status: 404 });
    return new Response(new Uint8Array(object.bytes), { status: 200, headers: { 'content-type': object.type } });
  }

  const route = async (input: string | URL | Request, init: RequestInit | undefined): Promise<Response> => {
    const url = requestUrl(input);
    const method = (init?.method ?? 'GET').toUpperCase();
    const body = init?.body;

    if (url.hostname === 'cdn.shopify.com' && method === 'GET') return cdn(url);
    if (method === 'POST' && body instanceof FormData && (url.hostname.includes('shopify-staged-uploads') || url.hostname.includes('shopify-video-production'))) {
      return stagedUpload(url, body);
    }

    const shop = state.shops.get(url.hostname);
    if (shop !== undefined && method === 'POST') {
      if (url.pathname === '/admin/oauth/access_token' && body instanceof URLSearchParams) {
        const form = Object.fromEntries(body.entries());
        return form.grant_type === EXCHANGE_GRANT ? tokenExchange(shop, form) : tokenEndpoint(shop, form);
      }
      if (url.pathname === `/admin/api/${options.apiVersion}/graphql.json` && typeof body === 'string') {
        return graphql(shop, new Headers(init?.headers), body);
      }
    }

    state.unexpected.push(`${method} ${url.href}`);
    throw new Error(`The e2e stub got an unexpected request: ${method} ${url.href}`);
  };

  const stub: ShopifyStub = {
    state,
    fetch: (input, init) => route(input, init),

    addShop(domain, seeds = DEFAULT_PRODUCTS) {
      const number = state.shops.size + 1;
      const shop: StubShop = {
        domain,
        number,
        info: { id: `gid://shopify/Shop/${1000 + number}`, name: `Store ${number}`, email: `owner${number}@${domain}`, currencyCode: 'INR', ianaTimezone: 'Asia/Kolkata' },
        products: [],
        offlineTokens: new Set(),
        onlineTokens: new Set(),
        refreshToken: null,
        stagedByKey: new Map(),
        files: new Map(),
      };
      shop.products = seeds.map((seed, index): StubProduct => {
        const imageUrls = Array.from({ length: seed.images ?? 2 }, (_unused, k) => productImageUrl(shop, seed.handle, k));
        for (const imageUrl of imageUrls) state.cdn.set(new URL(imageUrl).pathname, { bytes: FAKE_JPEG, type: 'image/jpeg' });
        return {
          id: `gid://shopify/Product/${8_000_000_000_000 + number * 1000 + index + 1}`,
          title: seed.title,
          handle: seed.handle,
          vendor: seed.vendor ?? 'Atelier Nord',
          productType: seed.productType ?? 'Home',
          status: 'ACTIVE',
          descriptionHtml: seed.descriptionHtml ?? `<p>${seed.title}</p>`,
          tags: ['home', 'e2e'],
          options: [{ name: 'Color', values: ['Natural', 'Black'] }],
          imageUrls,
        };
      });
      state.shops.set(domain, shop);
      return shop;
    },

    shop: shopByDomain,

    approve(authorizeUrl, approveOptions = {}) {
      const url = new URL(authorizeUrl);
      const shop = shopByDomain(url.hostname);
      if (url.pathname !== '/admin/oauth/authorize') throw new Error(`Not an authorize URL: ${authorizeUrl}`);
      if (url.searchParams.get('client_id') !== options.apiKey) throw new Error('authorize URL has the wrong client_id');
      const nonce = url.searchParams.get('state');
      const redirectUri = url.searchParams.get('redirect_uri');
      if (nonce === null || redirectUri !== options.redirectUri) throw new Error(`authorize URL has the wrong state or redirect_uri: ${redirectUri}`);

      const online = url.searchParams.getAll('grant_options[]').includes('per-user');
      const code = `code_${++state.counter}`;
      pending.set(code, {
        shop: shop.domain,
        online,
        scope: approveOptions.scope ?? url.searchParams.get('scope') ?? '',
        user: online ? { ...DEFAULT_USER, ...approveOptions.user } : null,
      });
      const params = { code, shop: shop.domain, state: nonce, timestamp: '1760000000', host: 'YWRtaW4', ...approveOptions.extra };
      return `${new URL(redirectUri).pathname}?${signedQueryString(params, options.apiSecret)}`;
    },

    revokeTokens(domain) {
      const shop = shopByDomain(domain);
      shop.offlineTokens.clear();
      shop.onlineTokens.clear();
      shop.refreshToken = null;
    },

    uninstallApp(domain) {
      stub.revokeTokens(domain);
      state.knobs.refuseExchange.add(domain);
    },

    reinstallApp(domain) {
      shopByDomain(domain);
      state.knobs.refuseExchange.delete(domain);
    },

    graphqlOperations(shop) {
      return state.calls.flatMap((call) => (call.kind === 'graphql' && (shop === undefined || call.shop === shop) ? [call.operation] : []));
    },
  };
  return stub;
}
