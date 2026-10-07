import type { DriverDeps } from './deps';
import { MediaAssetModel } from './models';
import { createMediaRouter } from './routes';
import { S3StorageDriver } from './s3-driver';
import { createMediaService } from './service';
import { ShopifyStorageDriver } from './shopify-driver';
import type { MediaModule, MediaModuleOptions, StorageDriver } from './index';

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Wire once at boot, after the shopify and auth modules exist. The batches module is created later and
// supplies isMediaInUse, so pass a lazy predicate:
//   const media = createMediaModule({
//     admin: shopify.admin, requireAuth: auth.requireAuth, getConfig: () => config.get(), logger,
//     isMediaInUse: (shopId, mediaId) => batchesIsMediaInUse(shopId, mediaId),
//   });
//   app.use('/api/v1', media.router);        // POST /media/uploads, POST /media/:id/complete, GET /media, DELETE /media/:id
//   generation uses media.service.storage.persistOutput; batches use media.service.getAssets / getObjects;
//   shop/redact calls media.service.purgeShop; media.ensureIndexes() once after the Mongo connection.
export function createMediaModule(options: MediaModuleOptions): MediaModule {
  const deps: DriverDeps = {
    admin: options.admin,
    getConfig: options.getConfig,
    logger: options.logger,
    fetchImpl: options.fetchImpl ?? fetch,
    now: options.now ?? (() => new Date()),
    sleep: options.sleep ?? defaultSleep,
  };
  const shopify = new ShopifyStorageDriver(deps);
  const s3 = new S3StorageDriver();
  // storage.driver is read at each call, like the rest of the live config.
  const active = (): StorageDriver => (options.getConfig().storage.driver === 's3' ? s3 : shopify);

  const storage: StorageDriver = {
    get provider() {
      return active().provider;
    },
    createUploadTargets: (actor, files) => active().createUploadTargets(actor, files),
    completeUpload: (actor, mediaId) => active().completeUpload(actor, mediaId),
    refreshStatus: (shopId, mediaIds) => active().refreshStatus(shopId, mediaIds),
    persistOutput: (input) => active().persistOutput(input),
    delete: (shopId, mediaId) => active().delete(shopId, mediaId),
  };

  const service = createMediaService({ storage, isMediaInUse: options.isMediaInUse ?? (() => Promise.resolve(false)) });
  return {
    service,
    router: createMediaRouter(service, options.requireAuth),
    async ensureIndexes() {
      await MediaAssetModel.createIndexes();
    },
  };
}
