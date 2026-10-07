import type { WebhookTopic } from '@rs/shared';

export interface ShopifyThrottleStatus {
  maximumAvailable: number;
  currentlyAvailable: number;
  restoreRate: number;
}

export interface ShopifyQueryCost {
  requestedQueryCost: number;
  actualQueryCost: number | null;
  throttleStatus: ShopifyThrottleStatus;
}

export interface GraphqlResponse<TData> {
  data: TData;
  cost: ShopifyQueryCost | null;
}

// Admin GraphQL only (SPEC 5). Pins SHOPIFY_API_VERSION, backs off on THROTTLED (max 3 retries)
// and maps GraphQL and HTTP errors to AppError.
export interface ShopifyAdminClient {
  query<TData>(shopId: string, query: string, variables?: Record<string, unknown>): Promise<GraphqlResponse<TData>>;
}

export interface WebhookContext {
  webhookId: string;
  topic: WebhookTopic;
  shopDomain: string;
  payload: unknown;
}

export type WebhookHandler = (context: WebhookContext) => Promise<void>;

export interface ShopifyService {
  readonly admin: ShopifyAdminClient;
  registerWebhookHandler(topic: WebhookTopic, handler: WebhookHandler): void;
}
