import { Types } from 'mongoose';
import type { MediaObject, MediaStatus, MediaType, ProductSnapshot } from '@rs/shared';
import { AppError } from '../../src/core/errors';
import type { CatalogService } from '../../src/modules/catalog';
import type { AttachTarget, MediaAssetRecord, MediaService, PersistOutputInput } from '../../src/modules/media';

// In-memory stand-ins for the catalog and media modules (track E), behind the same interfaces.

export interface FakeCatalog extends Pick<CatalogService, 'snapshotProducts'> {
  products: Map<string, ProductSnapshot>;
  addProduct(overrides?: Partial<ProductSnapshot>): string;
}

export function createFakeCatalog(): FakeCatalog {
  const products = new Map<string, ProductSnapshot>();
  let next = 1000;
  return {
    products,
    addProduct(overrides = {}) {
      next += 1;
      const gid = `gid://shopify/Product/${next}`;
      products.set(gid, {
        title: `Lamp ${next}`,
        handle: `lamp-${next}`,
        descriptionText: 'A simple ceramic table lamp.',
        productType: 'Lamp',
        vendor: 'Acme',
        tags: ['home'],
        options: [{ name: 'Color', values: ['White'] }],
        featuredImageUrl: `https://cdn.test/p/${next}-1.jpg?width=1536`,
        imageUrls: [`https://cdn.test/p/${next}-1.jpg?width=1536`, `https://cdn.test/p/${next}-2.jpg?width=1536`],
        ...overrides,
      });
      return gid;
    },
    async snapshotProducts(_shopId, gids) {
      const result = new Map<string, ProductSnapshot>();
      for (const gid of gids) {
        const snapshot = products.get(gid);
        if (snapshot === undefined) throw AppError.notFound(`Product ${gid} was not found`);
        result.set(gid, snapshot);
      }
      return result;
    },
  };
}

export interface ReferenceSpec {
  shopId: string;
  mediaType?: MediaType;
  status?: MediaStatus;
  role?: MediaAssetRecord['role'];
  mimeType?: string;
  fileSize?: number;
  filename?: string;
}

export interface FakeMedia extends Pick<MediaService, 'getAssets' | 'getObjects' | 'purgeShop' | 'storage' | 'attachToProducts'> {
  assets: Map<string, MediaAssetRecord>;
  // Every attachToProducts call, in order.
  attachCalls: AttachTarget[][];
  persisted: PersistOutputInput[];
  addReference(spec: ReferenceSpec): string;
  // Makes the next persistOutput calls throw.
  persistFailures: { count: number; error?: Error };
}

function toObject(asset: MediaAssetRecord): MediaObject {
  return {
    id: asset.id,
    role: asset.role,
    mediaType: asset.mediaType,
    status: asset.status,
    url: asset.url,
    previewUrl: asset.previewUrl,
    width: asset.width,
    height: asset.height,
    durationSec: asset.durationSec,
    filename: asset.filename,
    scope: asset.scope,
    productGid: asset.productGid,
    shotTitle: asset.shotTitle,
    createdAt: asset.createdAt.toISOString(),
  };
}

export function createFakeMedia(now: () => Date): FakeMedia {
  const assets = new Map<string, MediaAssetRecord>();
  const bySourceJob = new Map<string, MediaAssetRecord>();
  const persisted: PersistOutputInput[] = [];
  const persistFailures: { count: number; error?: Error } = { count: 0 };
  const attachCalls: AttachTarget[][] = [];

  const ownedBy = (shopId: string, ids: string[]): MediaAssetRecord[] =>
    ids.flatMap((id) => {
      const asset = assets.get(id);
      return asset !== undefined && asset.shopId === shopId ? [asset] : [];
    });

  const media: FakeMedia = {
    assets,
    persisted,
    persistFailures,
    attachCalls,
    async attachToProducts(_shopId, targets) {
      attachCalls.push(targets);
      return targets.map((target) => ({ productGid: target.productGid, attached: target.mediaIds, alreadyAttached: [], failed: [] }));
    },
    addReference(spec) {
      const id = new Types.ObjectId().toHexString();
      const mediaType = spec.mediaType ?? 'image';
      const filename = spec.filename ?? `ref-${assets.size + 1}.${mediaType === 'image' ? 'jpg' : 'mp4'}`;
      assets.set(id, {
        id,
        shopId: spec.shopId,
        role: spec.role ?? 'reference',
        mediaType,
        status: spec.status ?? 'ready',
        filename,
        mimeType: spec.mimeType ?? (mediaType === 'image' ? 'image/jpeg' : 'video/mp4'),
        fileSize: spec.fileSize ?? 1024,
        url: `https://cdn.test/ref/${id}/${filename}`,
        previewUrl: `https://cdn.test/ref/${id}/preview.jpg`,
        width: 1024,
        height: 1024,
        durationSec: mediaType === 'video' ? 5 : null,
        scope: 'common',
        productGid: null,
        batchId: null,
        batchItemId: null,
        shotTitle: null,
        createdAt: now(),
      });
      return id;
    },
    async getAssets(shopId, ids) {
      return ownedBy(shopId, ids);
    },
    async getObjects(shopId, ids) {
      return ownedBy(shopId, ids).map(toObject);
    },
    async purgeShop(shopId) {
      for (const [id, asset] of assets) if (asset.shopId === shopId) assets.delete(id);
    },
    storage: {
      provider: 'shopify',
      async createUploadTargets() {
        throw new Error('not used in these tests');
      },
      async completeUpload() {
        throw new Error('not used in these tests');
      },
      async refreshStatus() {
        throw new Error('not used in these tests');
      },
      async delete() {
        throw new Error('not used in these tests');
      },
      async persistOutput(input) {
        const existing = bySourceJob.get(input.sourceJobId);
        if (existing !== undefined) return toObject(existing);
        if (persistFailures.count > 0) {
          persistFailures.count -= 1;
          throw persistFailures.error ?? new Error('Shopify file upload failed');
        }
        persisted.push(input);
        const id = new Types.ObjectId().toHexString();
        const asset: MediaAssetRecord = {
          id,
          shopId: input.shopId,
          role: 'output',
          mediaType: input.mediaType,
          status: 'ready',
          filename: input.filename,
          mimeType: input.mimeType,
          fileSize: input.bytes.byteLength,
          url: `https://cdn.test/out/${input.filename}`,
          previewUrl: `https://cdn.test/out/${input.filename}.preview.jpg`,
          width: null,
          height: null,
          durationSec: null,
          scope: null,
          productGid: input.productGid,
          batchId: input.batchId,
          batchItemId: input.batchItemId,
          shotTitle: input.shotTitle,
          createdAt: now(),
        };
        assets.set(id, asset);
        bySourceJob.set(input.sourceJobId, asset);
        return toObject(asset);
      },
    },
  };
  return media;
}
