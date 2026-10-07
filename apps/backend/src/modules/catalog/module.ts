import type { CatalogModule, CatalogModuleOptions } from './index';
import { ProductsService } from './products-service';
import { createCatalogRouter } from './routes';

// Wire once at boot, after the shopify and auth modules exist:
//   const catalog = createCatalogModule({ admin: shopify.admin, requireAuth: auth.requireAuth, logger });
//   app.use('/api/v1', catalog.router);   // GET /products and GET /products/:gid
//   batches get catalog.service (snapshotProducts).
export function createCatalogModule(options: CatalogModuleOptions): CatalogModule {
  const products = new ProductsService({ admin: options.admin, logger: options.logger });
  return {
    service: {
      listProducts: (shopId, query) => products.list(shopId, query),
      getProduct: (shopId, productGid) => products.get(shopId, productGid),
      snapshotProducts: (shopId, productGids) => products.getSnapshots(shopId, productGids),
    },
    router: createCatalogRouter(products, options.requireAuth),
  };
}
