import type {
  AuthSessionResponse,
  BatchDetail,
  BatchItemView,
  BatchJobView,
  BatchSummary,
  ItemStatus,
  JobStatus,
  MediaObject,
  MeResponse,
  ProductDetail,
  ProductListItem,
  ProductOption,
  ReferenceMode,
} from '@rs/shared';
import { ApiError, type Api } from './types';

// In-memory fixtures for EXPO_PUBLIC_API_MOCK=true. Image URLs are public placeholders (picsum.photos,
// a public sample mp4); the mock never talks to the backend. The staged upload target is mock://staged-upload,
// so the upload feature must skip the multipart POST in mock mode.

const LATENCY_MS = 120;
const IMAGES_PER_PRODUCT = 2;
const VIDEOS_PER_PRODUCT = 1;
const JOBS_PER_ITEM = 1 + IMAGES_PER_PRODUCT + VIDEOS_PER_PRODUCT;
const SAMPLE_VIDEO_URL = 'https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/ForBiggerBlazes.mp4';

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function objectId(n: number): string {
  return n.toString(16).padStart(24, '0');
}

function productGid(index: number): string {
  return `gid://shopify/Product/${8000000000 + index}`;
}

function picture(seed: string, width: number, height: number): string {
  return `https://picsum.photos/seed/${seed}/${width}/${height}`;
}

function slugify(title: string): string {
  return title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

interface ProductSeed {
  title: string;
  vendor: string;
  productType: string;
  tags: string[];
  options: ProductOption[];
  mediaCount: number;
  variantsCount: number;
}

const SEEDS: ProductSeed[] = [
  {
    title: 'Ceramic Table Lamp',
    vendor: 'Hearth & Co',
    productType: 'Lighting',
    tags: ['lamp', 'ceramic'],
    options: [{ name: 'Color', values: ['Sand', 'Clay'] }],
    mediaCount: 5,
    variantsCount: 2,
  },
  {
    title: 'Linen Throw Blanket',
    vendor: 'Northfield',
    productType: 'Textiles',
    tags: ['linen', 'blanket'],
    options: [{ name: 'Color', values: ['Oat', 'Charcoal', 'Sage'] }],
    mediaCount: 4,
    variantsCount: 3,
  },
  {
    title: 'Walnut Serving Board',
    vendor: 'Oak & Ember',
    productType: 'Kitchen',
    tags: ['walnut', 'serving'],
    options: [{ name: 'Size', values: ['Medium', 'Large'] }],
    mediaCount: 3,
    variantsCount: 2,
  },
  {
    title: 'Leather Weekender Bag',
    vendor: 'Marlow',
    productType: 'Bags',
    tags: ['leather', 'travel'],
    options: [{ name: 'Color', values: ['Tan', 'Black'] }],
    mediaCount: 6,
    variantsCount: 2,
  },
  {
    title: 'Stoneware Mug Set',
    vendor: 'Hearth & Co',
    productType: 'Kitchen',
    tags: ['stoneware', 'mug'],
    options: [{ name: 'Set', values: ['2 piece', '4 piece'] }],
    mediaCount: 4,
    variantsCount: 2,
  },
  {
    title: 'Brass Desk Clock',
    vendor: 'Vesper',
    productType: 'Decor',
    tags: ['brass', 'clock'],
    options: [],
    mediaCount: 3,
    variantsCount: 1,
  },
  {
    title: 'Wool Runner Rug',
    vendor: 'Northfield',
    productType: 'Textiles',
    tags: ['wool', 'rug'],
    options: [{ name: 'Size', values: ['2x6', '3x8'] }],
    mediaCount: 5,
    variantsCount: 2,
  },
  {
    title: 'Glass Water Carafe',
    vendor: 'Vesper',
    productType: 'Kitchen',
    tags: ['glass', 'carafe'],
    options: [],
    mediaCount: 3,
    variantsCount: 1,
  },
];

const PRODUCTS: ProductDetail[] = SEEDS.map((seed, index) => {
  const handle = slugify(seed.title);
  const imageUrls = [1, 2, 3].map((n) => picture(`${handle}-${n}`, 1536, 2048));
  return {
    id: productGid(index),
    title: seed.title,
    handle,
    descriptionText: `${seed.title} by ${seed.vendor}. A fixture product for mock mode.`,
    productType: seed.productType,
    vendor: seed.vendor,
    tags: seed.tags,
    options: seed.options,
    featuredImageUrl: imageUrls[0] ?? null,
    imageUrls,
  };
});

function toListItem(product: ProductDetail, index: number): ProductListItem {
  const seed = SEEDS[index];
  return {
    id: product.id,
    title: product.title,
    handle: product.handle,
    status: 'ACTIVE',
    vendor: product.vendor,
    productType: product.productType,
    imageUrl: product.featuredImageUrl === null ? null : picture(`${product.handle}-thumb`, 300, 400),
    mediaCount: seed?.mediaCount ?? 1,
    variantsCount: seed?.variantsCount ?? 1,
  };
}

export function mockSession(): AuthSessionResponse {
  return {
    accessToken: 'mock-access-token',
    accessTokenExpiresAt: new Date(Date.now() + 15 * 60_000).toISOString(),
    refreshToken: 'mock-refresh-token',
    user: { id: objectId(1), email: 'owner@mock-store.myshopify.com', firstName: 'Alex', lastName: 'Mock' },
    shop: { id: objectId(2), domain: 'mock-store.myshopify.com', name: 'Mock Store' },
  };
}

const ME: MeResponse = {
  user: mockSession().user,
  shop: mockSession().shop,
  generation: {
    imagesPerProduct: IMAGES_PER_PRODUCT,
    videosPerProduct: VIDEOS_PER_PRODUCT,
    references: {
      maxPerProduct: 5,
      maxCommon: 10,
      maxImageMB: 20,
      maxVideoMB: 100,
      maxVideoSeconds: 60,
      imageMimeTypes: ['image/jpeg', 'image/png', 'image/webp'],
      videoMimeTypes: ['video/mp4', 'video/quicktime'],
    },
    maxProductsPerBatch: 50,
  },
};

interface MockBatch {
  index: number;
  id: string;
  createdAtMs: number;
  cancelledAtMs: number | null;
  idempotencyKey: string;
  items: { productGid: string; referenceMode: ReferenceMode }[];
}

// Item i completes this long after the batch is created.
function completionMs(itemIndex: number): number {
  return 6_000 + itemIndex * 3_000;
}

function deriveItem(batch: MockBatch, itemIndex: number, elapsedMs: number): BatchItemView {
  const item = batch.items[itemIndex];
  const product = PRODUCTS.find((p) => p.id === item?.productGid);
  const doneAt = completionMs(itemIndex);
  const cancelled = batch.cancelledAtMs !== null && elapsedMs < doneAt;

  let status: ItemStatus;
  if (cancelled) status = 'cancelled';
  else if (elapsedMs < 1_500) status = 'pending';
  else if (elapsedMs < 3_500) status = 'planning';
  else if (elapsedMs < doneAt) status = 'generating';
  else status = 'completed';

  const firstImageReady = status === 'completed' || (status === 'generating' && elapsedMs >= doneAt - 1_500);
  const allReady = status === 'completed';
  const doneAtIso = new Date(batch.createdAtMs + doneAt).toISOString();
  const base = 0x700000 + batch.index * 1000 + itemIndex * 10;

  const outputs: MediaObject[] = [];
  const handle = product?.handle ?? 'product';
  const output = (k: number, mediaType: 'image' | 'video', title: string): MediaObject => ({
    id: objectId(base + k),
    role: 'output',
    mediaType,
    status: 'ready',
    url: mediaType === 'image' ? picture(`${handle}-out-${k}`, 1536, 2048) : SAMPLE_VIDEO_URL,
    previewUrl: picture(`${handle}-out-${k}`, 600, 800),
    width: mediaType === 'image' ? 1536 : 720,
    height: mediaType === 'image' ? 2048 : 1280,
    durationSec: mediaType === 'video' ? 8 : null,
    filename: `rs-${handle}-${batch.id.slice(-6)}-${mediaType === 'image' ? 'img' : 'vid'}${k}.${mediaType === 'image' ? 'jpg' : 'mp4'}`,
    scope: null,
    productGid: item?.productGid ?? null,
    shotTitle: title,
    createdAt: doneAtIso,
  });
  if (firstImageReady) outputs.push(output(0, 'image', 'Hero shot'));
  if (allReady) {
    outputs.push(output(1, 'image', 'Detail shot'));
    outputs.push(output(2, 'video', 'Slow push-in'));
  }

  const stage = (running: JobStatus, blocked: JobStatus): JobStatus => (cancelled ? 'cancelled' : status === 'completed' ? 'succeeded' : status === 'generating' ? running : blocked);
  const jobs: BatchJobView[] = [
    {
      type: 'plan',
      outputIndex: null,
      status: cancelled ? 'cancelled' : status === 'pending' ? 'queued' : status === 'planning' ? 'running' : 'succeeded',
      errorCode: null,
    },
    { type: 'image', outputIndex: 0, status: firstImageReady && !cancelled ? 'succeeded' : stage('running', 'blocked'), errorCode: null },
    { type: 'image', outputIndex: 1, status: stage('running', 'blocked'), errorCode: null },
    { type: 'video', outputIndex: 0, status: stage('awaiting_operation', 'blocked'), errorCode: null },
  ];

  return {
    id: objectId(0x600000 + batch.index * 1000 + itemIndex),
    productGid: item?.productGid ?? '',
    title: product?.title ?? 'Unknown product',
    imageUrl: product?.featuredImageUrl ?? null,
    status,
    referenceMode: item?.referenceMode ?? 'common_only',
    outputs,
    jobs,
  };
}

function deriveBatch(batch: MockBatch, nowMs: number): BatchDetail {
  const elapsedMs = (batch.cancelledAtMs ?? nowMs) - batch.createdAtMs;
  const items = batch.items.map((_, index) => deriveItem(batch, index, elapsedMs));

  const jobs = items.flatMap((item) => item.jobs);
  const count = (status: JobStatus): number => jobs.filter((job) => job.status === status).length;
  const allCompleted = items.every((item) => item.status === 'completed');
  const anyCancelled = items.some((item) => item.status === 'cancelled');

  let status: BatchDetail['status'];
  if (anyCancelled) status = 'cancelled';
  else if (elapsedMs < 1_500) status = 'queued';
  else if (allCompleted) status = 'completed';
  else status = 'running';

  const terminal = status === 'completed' || status === 'cancelled';
  const finishedMs = status === 'cancelled' ? (batch.cancelledAtMs ?? nowMs) : batch.createdAtMs + completionMs(items.length - 1);

  return {
    id: batch.id,
    status,
    counts: {
      products: items.length,
      jobsTotal: items.length * JOBS_PER_ITEM,
      jobsSucceeded: count('succeeded'),
      jobsFailed: 0,
      jobsCancelled: count('cancelled'),
      imagesReady: items.reduce((sum, item) => sum + item.outputs.filter((o) => o.mediaType === 'image').length, 0),
      videosReady: items.reduce((sum, item) => sum + item.outputs.filter((o) => o.mediaType === 'video').length, 0),
    },
    createdAt: new Date(batch.createdAtMs).toISOString(),
    finishedAt: terminal ? new Date(finishedMs).toISOString() : null,
    coverImageUrl: items[0]?.imageUrl ?? null,
    configSnapshot: { outputs: { imagesPerProduct: IMAGES_PER_PRODUCT, videosPerProduct: VIDEOS_PER_PRODUCT } },
    items,
    delay: null,
  };
}

function toSummary(detail: BatchDetail): BatchSummary {
  return {
    id: detail.id,
    status: detail.status,
    counts: detail.counts,
    createdAt: detail.createdAt,
    finishedAt: detail.finishedAt,
    coverImageUrl: detail.coverImageUrl,
    configSnapshot: detail.configSnapshot,
  };
}

export function createMockApi(): Api {
  const batches = new Map<string, MockBatch>();
  const media = new Map<string, MediaObject>();
  let mediaCounter = 0x500000;

  const seeded: MockBatch = {
    index: 0,
    id: objectId(0x400000),
    createdAtMs: Date.now() - 60 * 60_000,
    cancelledAtMs: null,
    idempotencyKey: 'seeded',
    items: [0, 1, 2].map((i) => ({ productGid: productGid(i), referenceMode: 'common_only' as const })),
  };
  batches.set(seeded.id, seeded);

  const requireBatch = (id: string): MockBatch => {
    const batch = batches.get(id);
    if (batch === undefined) throw new ApiError(404, 'not_found', 'Batch not found');
    return batch;
  };

  return {
    auth: {
      exchange: async () => {
        await delay(LATENCY_MS);
        return mockSession();
      },
      refresh: async () => {
        await delay(LATENCY_MS);
        return mockSession();
      },
      logout: async () => {
        await delay(LATENCY_MS);
      },
    },
    me: async () => {
      await delay(LATENCY_MS);
      return ME;
    },
    products: {
      list: async (params) => {
        await delay(LATENCY_MS);
        const query = params?.q?.trim().toLowerCase() ?? '';
        const matches = PRODUCTS.map((product, index) => ({ product, index })).filter(({ product }) =>
          product.title.toLowerCase().includes(query),
        );
        const start = params?.cursor === undefined ? 0 : Number.parseInt(params.cursor, 10) || 0;
        const limit = params?.limit ?? 25;
        const page = matches.slice(start, start + limit);
        const end = start + page.length;
        return {
          items: page.map(({ product, index }) => toListItem(product, index)),
          pageInfo: { endCursor: page.length > 0 ? String(end) : null, hasNextPage: end < matches.length },
        };
      },
      get: async (gid) => {
        await delay(LATENCY_MS);
        const product = PRODUCTS.find((p) => p.id === gid);
        if (product === undefined) throw new ApiError(404, 'not_found', 'Product not found');
        return product;
      },
    },
    media: {
      createUploads: async (body) => {
        await delay(LATENCY_MS);
        const targets = body.files.map((file) => {
          mediaCounter += 1;
          const id = objectId(mediaCounter);
          media.set(id, {
            id,
            role: 'reference',
            mediaType: file.mimeType.startsWith('video/') ? 'video' : 'image',
            status: 'awaiting_upload',
            url: null,
            previewUrl: null,
            width: null,
            height: null,
            durationSec: file.durationSec ?? null,
            filename: file.filename,
            scope: file.scope,
            productGid: file.productGid ?? null,
            shotTitle: null,
            createdAt: new Date().toISOString(),
          });
          return { clientId: file.clientId, mediaId: id, url: 'mock://staged-upload', method: 'POST' as const, parameters: [] };
        });
        return { targets };
      },
      complete: async (id) => {
        await delay(LATENCY_MS);
        const existing = media.get(id);
        if (existing === undefined) throw new ApiError(404, 'not_found', 'Media not found');
        const ready: MediaObject = {
          ...existing,
          status: 'ready',
          url: picture(`ref-${id}`, 1536, 2048),
          previewUrl: picture(`ref-${id}`, 600, 800),
          width: 1536,
          height: 2048,
        };
        media.set(id, ready);
        return ready;
      },
      list: async (ids) => {
        await delay(LATENCY_MS);
        return { items: ids.flatMap((id) => media.get(id) ?? []) };
      },
      remove: async (id) => {
        await delay(LATENCY_MS);
        if (!media.delete(id)) throw new ApiError(404, 'not_found', 'Media not found');
      },
    },
    batches: {
      create: async (body) => {
        await delay(LATENCY_MS);
        for (const existing of batches.values()) {
          if (existing.idempotencyKey === body.idempotencyKey) return toSummary(deriveBatch(existing, Date.now()));
        }
        const common = body.commonReferenceMediaIds ?? [];
        const unresolved = body.products
          .filter((p) => (p.referenceMediaIds ?? []).length === 0 && common.length === 0)
          .map((p) => p.productGid);
        if (unresolved.length > 0) {
          throw new ApiError(422, 'references_required', 'Some products have no references', { productGids: unresolved });
        }
        const index = batches.size;
        const batch: MockBatch = {
          index,
          id: objectId(0x400000 + index),
          createdAtMs: Date.now(),
          cancelledAtMs: null,
          idempotencyKey: body.idempotencyKey,
          items: body.products.map((p) => {
            const own = (p.referenceMediaIds ?? []).length > 0;
            const mode: ReferenceMode = own ? (common.length > 0 ? 'own_plus_common' : 'own_only') : 'common_only';
            return { productGid: p.productGid, referenceMode: mode };
          }),
        };
        batches.set(batch.id, batch);
        return toSummary(deriveBatch(batch, Date.now()));
      },
      list: async () => {
        await delay(LATENCY_MS);
        const items = [...batches.values()]
          .sort((a, b) => b.createdAtMs - a.createdAtMs)
          .map((batch) => toSummary(deriveBatch(batch, Date.now())));
        return { items, pageInfo: { endCursor: null, hasNextPage: false } };
      },
      get: async (id) => {
        await delay(LATENCY_MS);
        return deriveBatch(requireBatch(id), Date.now());
      },
      cancel: async (id) => {
        await delay(LATENCY_MS);
        const batch = requireBatch(id);
        if (batch.cancelledAtMs === null) batch.cancelledAtMs = Date.now();
        return toSummary(deriveBatch(batch, Date.now()));
      },
      retryFailed: async (id) => {
        await delay(LATENCY_MS);
        return toSummary(deriveBatch(requireBatch(id), Date.now()));
      },
    },
  };
}
