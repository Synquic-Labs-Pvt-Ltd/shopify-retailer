import type { RequestHandler, Router } from 'express';
import type {
  ProductDetail,
  ProductListQuery,
  ProductListResponse,
  ProductSnapshot,
} from '@rs/shared';
import type { Logger } from '../../core/logger';
import type { ShopifyAdminClient } from '../shopify';

export interface CatalogService {
  listProducts(shopId: string, query: ProductListQuery): Promise<ProductListResponse>;
  getProduct(shopId: string, productGid: string): Promise<ProductDetail>;
  // Snapshots for a batch. Throws AppError not_found if any product is missing.
  snapshotProducts(shopId: string, productGids: string[]): Promise<Map<string, ProductSnapshot>>;
}

export interface CatalogModuleOptions {
  admin: ShopifyAdminClient;
  // Verifies the bearer JWT and sets req.auth (auth module).
  requireAuth: RequestHandler;
  logger: Logger;
}

export interface CatalogModule {
  service: CatalogService;
  // Paths relative to /api/v1: GET /products and GET /products/:gid.
  router: Router;
}

export { createCatalogModule } from './module';
