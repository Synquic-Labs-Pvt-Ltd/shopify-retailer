import type {
  ProductDetail,
  ProductListQuery,
  ProductListResponse,
  ProductSnapshot,
} from '@rs/shared';

export interface CatalogService {
  listProducts(shopId: string, query: ProductListQuery): Promise<ProductListResponse>;
  getProduct(shopId: string, productGid: string): Promise<ProductDetail>;
  // Snapshots for a batch. Throws AppError not_found if any product is missing.
  snapshotProducts(shopId: string, productGids: string[]): Promise<Map<string, ProductSnapshot>>;
}
