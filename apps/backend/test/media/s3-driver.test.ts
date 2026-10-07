import { describe, expect, it } from 'vitest';
import { defaultGenerationConfig } from '@rs/shared';
import { AppError } from '../../src/core/errors';
import { createMediaModule } from '../../src/modules/media';
import { S3StorageDriver } from '../../src/modules/media/s3-driver';
import { FakeShopify, newObjectId, silentLogger, SHOP_ID, USER_ID } from './kit';

const actor = { shopId: SHOP_ID, userId: USER_ID };
const output = {
  shopId: SHOP_ID,
  createdByUserId: USER_ID,
  batchId: newObjectId(),
  batchItemId: newObjectId(),
  sourceJobId: newObjectId(),
  productGid: 'gid://shopify/Product/1',
  mediaType: 'image' as const,
  mimeType: 'image/jpeg',
  bytes: new Uint8Array([1, 2, 3]),
  filename: 'rs-lamp-ab12cd34-img1.jpg',
  alt: 'Lamp: Hero',
  shotTitle: 'Hero',
};

describe('S3StorageDriver', () => {
  const driver = new S3StorageDriver();

  it('reports the s3 provider', () => {
    expect(driver.provider).toBe('s3');
  });

  it('rejects every method with not_implemented', async () => {
    const calls: Promise<unknown>[] = [
      driver.createUploadTargets(actor, []),
      driver.completeUpload(actor, newObjectId()),
      driver.refreshStatus(SHOP_ID, []),
      driver.persistOutput(output),
      driver.delete(SHOP_ID, newObjectId()),
    ];
    for (const call of calls) {
      const error = await call.catch((err: unknown) => err);
      expect(error).toBeInstanceOf(AppError);
      expect(error).toMatchObject({ code: 'not_implemented', status: 501 });
    }
  });

  it('is what the module uses when the config selects s3', async () => {
    const shopify = new FakeShopify();
    const config = { ...defaultGenerationConfig, storage: { driver: 's3' as const } };
    const { service } = createMediaModule({
      admin: shopify.admin,
      requireAuth: (_req, _res, next) => next(),
      getConfig: () => config,
      logger: silentLogger,
    });

    expect(service.storage.provider).toBe('s3');
    await expect(service.storage.persistOutput(output)).rejects.toMatchObject({ code: 'not_implemented' });
    expect(shopify.calls).toHaveLength(0);
  });

  it('uses the shopify driver by default', () => {
    const { service } = createMediaModule({
      admin: new FakeShopify().admin,
      requireAuth: (_req, _res, next) => next(),
      getConfig: () => defaultGenerationConfig,
      logger: silentLogger,
    });
    expect(service.storage.provider).toBe('shopify');
  });
});
