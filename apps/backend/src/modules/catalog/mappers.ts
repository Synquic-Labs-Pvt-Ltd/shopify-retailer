import { PRODUCT_SNAPSHOT_MAX_IMAGES, type ProductDetail, type ProductListItem, type ProductSnapshot } from '@rs/shared';
import type { ProductListNode, ProductSnapshotNode } from './shopify-schemas';
import { htmlToPlainText } from './text';

export const SNAPSHOT_DESCRIPTION_MAX_CHARS = 2000;
export const SNAPSHOT_MAX_IMAGES = PRODUCT_SNAPSHOT_MAX_IMAGES;
export const SNAPSHOT_IMAGE_WIDTH = 1536;

// Asks the Shopify CDN to resize the image server side.
export function withWidth(url: string, width: number): string {
  try {
    const parsed = new URL(url);
    parsed.searchParams.set('width', String(width));
    return parsed.toString();
  } catch {
    return url;
  }
}

export function toListItem(node: ProductListNode): ProductListItem {
  return {
    id: node.id,
    title: node.title,
    handle: node.handle,
    status: node.status,
    vendor: node.vendor,
    productType: node.productType,
    imageUrl: node.featuredMedia?.preview?.image?.url ?? null,
    mediaCount: node.mediaCount?.count ?? 0,
    variantsCount: node.variantsCount?.count ?? 0,
  };
}

export function toSnapshot(node: ProductSnapshotNode): ProductSnapshot {
  const featured = node.featuredMedia?.preview?.image?.url;
  const imageUrls = node.media.nodes
    .flatMap((media) => (media.image?.url === undefined ? [] : [media.image.url]))
    .slice(0, SNAPSHOT_MAX_IMAGES)
    .map((url) => withWidth(url, SNAPSHOT_IMAGE_WIDTH));
  return {
    title: node.title,
    handle: node.handle,
    descriptionText: htmlToPlainText(node.descriptionHtml, SNAPSHOT_DESCRIPTION_MAX_CHARS),
    productType: node.productType,
    vendor: node.vendor,
    tags: node.tags,
    options: node.options.map((option) => ({ name: option.name, values: option.values })),
    featuredImageUrl: featured === undefined ? null : withWidth(featured, SNAPSHOT_IMAGE_WIDTH),
    imageUrls,
  };
}

export function toDetail(node: ProductSnapshotNode): ProductDetail {
  return { id: node.id, ...toSnapshot(node) };
}
