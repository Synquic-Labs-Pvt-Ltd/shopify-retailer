import type { GenerationConfig } from '@rs/shared';
import type { Logger } from '../../core/logger';
import type { ShopifyAdminClient } from '../shopify';

export interface DriverDeps {
  admin: ShopifyAdminClient;
  getConfig: () => GenerationConfig;
  logger: Logger;
  fetchImpl: typeof fetch;
  now: () => Date;
  sleep: (ms: number) => Promise<void>;
}
