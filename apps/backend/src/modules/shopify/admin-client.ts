import { z } from 'zod';
import { AppError } from '../../core/errors';
import type { Env } from '../../core/env';
import type { Logger } from '../../core/logger';
import type { ShopsInternalService } from '../shops';
import type { GraphqlResponse, ShopifyAdminClient, ShopifyQueryCost } from './index';

const REQUEST_TIMEOUT_MS = 30_000;
// SPEC 8.5: on THROTTLED wait, then retry, at most 3 times.
export const MAX_THROTTLE_RETRIES = 3;
const MIN_WAIT_MS = 100;
const MAX_WAIT_MS = 10_000;
const FALLBACK_WAIT_MS = 1_000;

const costSchema = z.object({
  requestedQueryCost: z.number(),
  actualQueryCost: z.number().nullable().default(null),
  throttleStatus: z.object({
    maximumAvailable: z.number(),
    currentlyAvailable: z.number(),
    restoreRate: z.number(),
  }),
});

interface GraphqlErrorItem {
  message: string;
  code: string | undefined;
}

const errorItemSchema = z.object({
  message: z.string().default('Unknown error'),
  extensions: z.object({ code: z.string().optional() }).optional(),
});

const bodySchema = z.object({
  data: z.unknown().optional(),
  errors: z.unknown().optional(),
  extensions: z.object({ cost: z.unknown().optional() }).optional(),
});

export interface AdminClientDeps {
  env: Pick<Env, 'SHOPIFY_API_VERSION'>;
  logger: Logger;
  shops: Pick<ShopsInternalService, 'requireActive' | 'getAccessToken' | 'markReauthRequired'>;
  fetchImpl?: typeof fetch;
  // Injectable so tests do not wait in real time.
  sleep?: (ms: number) => Promise<void>;
}

function upstream(message: string, details?: Record<string, unknown>, cause?: unknown): AppError {
  return new AppError('internal', message, { status: 502, details: { upstream: 'shopify', ...details }, cause });
}

function readErrors(raw: unknown): GraphqlErrorItem[] {
  if (raw === undefined || raw === null) return [];
  if (typeof raw === 'string') return [{ message: raw, code: undefined }];
  if (!Array.isArray(raw)) return [{ message: 'Unrecognized GraphQL error payload', code: undefined }];
  return raw.map((item) => {
    const parsed = errorItemSchema.safeParse(item);
    return parsed.success
      ? { message: parsed.data.message, code: parsed.data.extensions?.code }
      : { message: 'Unrecognized GraphQL error payload', code: undefined };
  });
}

// SPEC 8.5: wait (requested cost - currently available) / restoreRate seconds.
export function throttleWaitMs(cost: ShopifyQueryCost | null): number {
  if (cost === null || cost.throttleStatus.restoreRate <= 0) return FALLBACK_WAIT_MS;
  const missing = Math.max(0, cost.requestedQueryCost - cost.throttleStatus.currentlyAvailable);
  const waitMs = Math.ceil((missing / cost.throttleStatus.restoreRate) * 1000);
  return Math.min(MAX_WAIT_MS, Math.max(MIN_WAIT_MS, waitMs));
}

type Attempt<TData> = { kind: 'ok'; response: GraphqlResponse<TData> } | { kind: 'throttled'; waitMs: number };

export function createAdminClient(deps: AdminClientDeps): ShopifyAdminClient {
  const { env, logger, shops } = deps;
  const fetchImpl = deps.fetchImpl ?? fetch;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));

  const attempt = async <TData>(
    shopId: string,
    url: string,
    query: string,
    variables: Record<string, unknown> | undefined,
  ): Promise<Attempt<TData>> => {
    const accessToken = await shops.getAccessToken(shopId);

    let response: Response;
    try {
      response = await fetchImpl(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json', 'x-shopify-access-token': accessToken },
        body: JSON.stringify({ query, variables }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (err) {
      throw upstream('Could not reach Shopify', undefined, err);
    }

    if (response.status === 429) {
      const retryAfter = Number(response.headers.get('retry-after'));
      return { kind: 'throttled', waitMs: Number.isFinite(retryAfter) && retryAfter > 0 ? Math.min(MAX_WAIT_MS, retryAfter * 1000) : FALLBACK_WAIT_MS };
    }
    if (response.status === 401) {
      // The token is revoked or the app was uninstalled: the next mobile login must run the offline phase again.
      await shops.markReauthRequired(shopId);
      throw AppError.shopReauthRequired();
    }
    if (response.status === 402 || response.status === 403 || response.status === 423) {
      throw AppError.forbidden(`Shopify refused the request (HTTP ${response.status})`);
    }
    if (!response.ok) throw upstream(`Shopify returned HTTP ${response.status}`, { status: response.status });

    const body = bodySchema.safeParse(await response.json().catch(() => null));
    if (!body.success) throw upstream('Shopify returned an unreadable response');

    const cost = costSchema.safeParse(body.data.extensions?.cost);
    const queryCost: ShopifyQueryCost | null = cost.success ? cost.data : null;

    const errors = readErrors(body.data.errors);
    if (errors.some((error) => error.code === 'THROTTLED')) {
      if (queryCost !== null && queryCost.requestedQueryCost > queryCost.throttleStatus.maximumAvailable) {
        throw upstream('The query costs more than the Shopify rate-limit bucket can hold', { requestedQueryCost: queryCost.requestedQueryCost });
      }
      return { kind: 'throttled', waitMs: throttleWaitMs(queryCost) };
    }
    if (errors.length > 0) {
      if (errors.some((error) => error.code === 'ACCESS_DENIED')) throw AppError.forbidden('Shopify denied access to the requested data');
      logger.error({ errors }, 'Shopify GraphQL errors');
      throw upstream('Shopify GraphQL request failed', { errors });
    }
    if (body.data.data === undefined || body.data.data === null) throw upstream('Shopify returned no data');

    return { kind: 'ok', response: { data: body.data.data as TData, cost: queryCost } };
  };

  return {
    async query<TData>(shopId: string, query: string, variables?: Record<string, unknown>): Promise<GraphqlResponse<TData>> {
      const shop = await shops.requireActive(shopId);
      const url = `https://${shop.shopDomain}/admin/api/${env.SHOPIFY_API_VERSION}/graphql.json`;

      for (let retry = 0; ; retry++) {
        const result = await attempt<TData>(shopId, url, query, variables);
        if (result.kind === 'ok') return result.response;

        if (retry >= MAX_THROTTLE_RETRIES) {
          throw new AppError('too_many_requests', 'Shopify is throttling requests, try again shortly');
        }
        logger.warn({ shopId, retry: retry + 1, waitMs: result.waitMs }, 'Shopify throttled the request, backing off');
        await sleep(result.waitMs);
      }
    },
  };
}
