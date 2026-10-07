import { z } from 'zod';
import { graphqlData } from './stub-http';
import type { StubProduct, StubShop } from './stub-state';

const listVariables = z.object({ first: z.number().int().positive(), after: z.string().nullable(), query: z.string().nullable() });
const idVariables = z.object({ id: z.string() });
const idsVariables = z.object({ ids: z.array(z.string()) });

const CDN_HOST = 'https://cdn.shopify.com';

export function productImageUrl(shop: StubShop, handle: string, index: number): string {
  return `${CDN_HOST}/s/files/1/${shop.number}/products/${handle}-${index + 1}.jpg?v=1760000000`;
}

function featuredMedia(product: StubProduct) {
  const url = product.imageUrls[0];
  return url === undefined ? null : { preview: { image: { url } } };
}

function listNode(product: StubProduct) {
  return {
    id: product.id,
    title: product.title,
    handle: product.handle,
    status: product.status,
    vendor: product.vendor,
    productType: product.productType,
    featuredMedia: featuredMedia(product),
    mediaCount: { count: product.imageUrls.length },
    variantsCount: { count: 1 },
  };
}

function snapshotNode(product: StubProduct, mediaFirst: number) {
  return {
    id: product.id,
    title: product.title,
    handle: product.handle,
    descriptionHtml: product.descriptionHtml,
    productType: product.productType,
    vendor: product.vendor,
    tags: product.tags,
    options: product.options,
    featuredMedia: featuredMedia(product),
    media: { nodes: product.imageUrls.slice(0, mediaFirst).map((url) => ({ image: { url } })) },
  };
}

// The app sends title:*word* terms; every term must match the title (Shopify search AND semantics).
function matchesSearch(product: StubProduct, search: string | null): boolean {
  if (search === null) return true;
  const terms = [...search.matchAll(/title:\*(.*?)\*(?=\s|$)/g)].map((match) => (match[1] ?? '').replace(/\\(.)/g, '$1').toLowerCase());
  return terms.every((term) => product.title.toLowerCase().includes(term));
}

function encodeCursor(index: number): string {
  return Buffer.from(`idx:${index}`).toString('base64url');
}

function decodeCursor(cursor: string): number {
  const index = Number(/^idx:(\d+)$/.exec(Buffer.from(cursor, 'base64url').toString('utf8'))?.[1]);
  return Number.isInteger(index) ? index : -1;
}

export function productList(shop: StubShop, rawVariables: Record<string, unknown>): Response {
  const variables = listVariables.parse(rawVariables);
  const matching = shop.products.map((product, index) => ({ product, index })).filter(({ product }) => matchesSearch(product, variables.query));
  const start = variables.after === null ? 0 : matching.findIndex(({ index }) => index === decodeCursor(variables.after ?? '')) + 1;
  const page = matching.slice(start, start + variables.first);
  const last = page[page.length - 1];
  return graphqlData({
    products: {
      nodes: page.map(({ product }) => listNode(product)),
      pageInfo: { hasNextPage: start + page.length < matching.length, endCursor: last === undefined ? null : encodeCursor(last.index) },
    },
  });
}

function mediaFirstOf(query: string): number {
  return Number(/media\(first:\s*(\d+)/.exec(query)?.[1] ?? 5);
}

export function productDetail(shop: StubShop, query: string, rawVariables: Record<string, unknown>): Response {
  const { id } = idVariables.parse(rawVariables);
  const product = shop.products.find((candidate) => candidate.id === id);
  return graphqlData({ product: product === undefined ? null : snapshotNode(product, mediaFirstOf(query)) });
}

// Unknown ids, including gids of another shop, come back as null.
export function productSnapshots(shop: StubShop, query: string, rawVariables: Record<string, unknown>): Response {
  const { ids } = idsVariables.parse(rawVariables);
  const first = mediaFirstOf(query);
  return graphqlData({
    nodes: ids.map((id) => {
      const product = shop.products.find((candidate) => candidate.id === id);
      return product === undefined ? null : snapshotNode(product, first);
    }),
  });
}
