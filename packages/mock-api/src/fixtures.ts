import type {
  AuthSessionResponse,
  MeResponse,
  ProductDetail,
  ProductListItem,
  ProductOption,
  ProductStatus,
} from '@rs/shared';
import { IMAGES_PER_PRODUCT, VIDEOS_PER_PRODUCT, objectId, picture, productGid, slugify } from './util';

interface ProductSeed {
  title: string;
  vendor: string;
  productType: string;
  tags: string[];
  options: ProductOption[];
  mediaCount: number;
  variantsCount: number;
}

const HANDWRITTEN: ProductSeed[] = [
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
  {
    title: 'Hand-Woven Organic Cotton Throw Pillow Cover with Embroidered Edge',
    vendor: '',
    productType: 'Textiles',
    tags: ['cotton', 'pillow'],
    options: [],
    mediaCount: 2,
    variantsCount: 1,
  },
];

const MATERIALS = ['Marble', 'Rattan', 'Copper', 'Oak', 'Cotton', 'Slate'];
const OBJECTS: { name: string; type: string; vendor: string }[] = [
  { name: 'Side Table', type: 'Furniture', vendor: 'Oak & Ember' },
  { name: 'Wall Mirror', type: 'Decor', vendor: 'Vesper' },
  { name: 'Planter', type: 'Garden', vendor: 'Hearth & Co' },
  { name: 'Storage Basket', type: 'Storage', vendor: 'Northfield' },
  { name: 'Candle Holder', type: 'Decor', vendor: 'Vesper' },
  { name: 'Serving Tray', type: 'Kitchen', vendor: 'Marlow' },
];

// 9 handwritten products and 36 generated ones.
const GENERATED: ProductSeed[] = MATERIALS.flatMap((material, m) =>
  OBJECTS.map((object, o) => ({
    title: `${material} ${object.name}`,
    vendor: object.vendor,
    productType: object.type,
    tags: [material.toLowerCase(), object.name.toLowerCase()],
    options: [],
    mediaCount: 1 + ((m * 3 + o) % 6),
    variantsCount: 1 + ((m + o) % 3),
  })),
);

const SEEDS: ProductSeed[] = [...HANDWRITTEN, ...GENERATED];

// The products at these indexes have no image (an active one, a draft and another active one). GET /products leaves
// them out like the real backend does; GET /products/:gid still serves them.
const NO_IMAGE_INDEXES: ReadonlySet<number> = new Set([12, 25, 38]);

const ARCHIVED_INDEX = 30;

// From the tenth product on, every fourth is a draft; one is archived and the rest are active.
function statusOf(index: number): ProductStatus {
  if (index === ARCHIVED_INDEX) return 'ARCHIVED';
  return index >= 9 && index % 4 === 1 ? 'DRAFT' : 'ACTIVE';
}

export const PRODUCTS: ProductDetail[] = SEEDS.map((seed, index) => {
  const handle = slugify(seed.title);
  const imageUrls = NO_IMAGE_INDEXES.has(index) ? [] : [1, 2, 3].map((n) => picture(`${handle}-${n}`, 1536, 2048));
  return {
    id: productGid(index),
    title: seed.title,
    handle,
    descriptionText: `${seed.title}${seed.vendor === '' ? '' : ` by ${seed.vendor}`}. A fixture product for mock mode.`,
    productType: seed.productType,
    vendor: seed.vendor,
    tags: seed.tags,
    options: seed.options,
    featuredImageUrl: imageUrls[0] ?? null,
    imageUrls,
  };
});

export function toListItem(product: ProductDetail, index: number): ProductListItem {
  const seed = SEEDS[index];
  return {
    id: product.id,
    title: product.title,
    handle: product.handle,
    status: statusOf(index),
    vendor: product.vendor,
    productType: product.productType,
    imageUrl: product.featuredImageUrl === null ? null : picture(`${product.handle}-thumb`, 300, 400),
    mediaCount: product.imageUrls.length === 0 ? 0 : (seed?.mediaCount ?? 1),
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

export const ME: MeResponse = {
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
