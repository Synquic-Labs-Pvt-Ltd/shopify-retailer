import { z } from 'zod';
import { productGidSchema } from '@rs/shared';
import type { PageInfo, ProductDetail, ProductListQuery, ProductListResponse, ProductSnapshot } from '@rs/shared';
import { AppError } from '../../core/errors';
import { parseWith } from '../../core/http';
import type { Logger } from '../../core/logger';
import type { ShopifyAdminClient } from '../shopify';
import { toDetail, toListItem, toSnapshot } from './mappers';
import { PRODUCT_DETAIL_QUERY, PRODUCT_LIST_QUERY, PRODUCT_SNAPSHOTS_QUERY } from './queries';
import { buildTitleSearch } from './search';
import { productDetailDataSchema, productListDataSchema, productSnapshotNodeSchema, productSnapshotsDataSchema } from './shopify-schemas';

// Keeps one nodes() query well under Shopify's single-query cost limit.
const SNAPSHOT_CHUNK_SIZE = 20;

export interface ProductsServiceOptions {
  admin: ShopifyAdminClient;
  logger: Logger;
}

export class ProductsService {
  private readonly admin: ShopifyAdminClient;
  private readonly logger: Logger;

  constructor(options: ProductsServiceOptions) {
    this.admin = options.admin;
    this.logger = options.logger;
  }

  async list(shopId: string, query: ProductListQuery): Promise<ProductListResponse> {
    const data = await this.run(shopId, PRODUCT_LIST_QUERY, productListDataSchema, {
      first: query.limit,
      after: query.cursor ?? null,
      query: buildTitleSearch(query.q),
    });
    const pageInfo: PageInfo = {
      endCursor: data.products.pageInfo.endCursor,
      hasNextPage: data.products.pageInfo.hasNextPage,
    };
    return { items: data.products.nodes.map(toListItem), pageInfo };
  }

  async get(shopId: string, gid: string): Promise<ProductDetail> {
    const productGid = parseWith(productGidSchema, gid);
    const data = await this.run(shopId, PRODUCT_DETAIL_QUERY, productDetailDataSchema, { id: productGid });
    if (data.product === null) throw AppError.notFound('Product not found');
    return toDetail(data.product);
  }

  // Throws not_found, with the missing gids in details, if any product no longer exists.
  async getSnapshots(shopId: string, gids: string[]): Promise<Map<string, ProductSnapshot>> {
    const unique = [...new Set(parseWith(z.array(productGidSchema), gids))];
    const snapshots = new Map<string, ProductSnapshot>();
    for (let start = 0; start < unique.length; start += SNAPSHOT_CHUNK_SIZE) {
      const chunk = unique.slice(start, start + SNAPSHOT_CHUNK_SIZE);
      const data = await this.run(shopId, PRODUCT_SNAPSHOTS_QUERY, productSnapshotsDataSchema, { ids: chunk });
      for (const node of data.nodes) {
        const parsed = productSnapshotNodeSchema.safeParse(node);
        if (parsed.success) snapshots.set(parsed.data.id, toSnapshot(parsed.data));
      }
    }
    const missing = unique.filter((gid) => !snapshots.has(gid));
    if (missing.length > 0) throw new AppError('not_found', 'Some products no longer exist', { details: { productGids: missing } });
    return snapshots;
  }

  private async run<T>(shopId: string, query: string, schema: z.ZodType<T>, variables: Record<string, unknown>): Promise<T> {
    const { data } = await this.admin.query<unknown>(shopId, query, variables);
    const parsed = schema.safeParse(data);
    if (!parsed.success) {
      this.logger.error({ issues: parsed.error.issues }, 'unexpected Shopify product response');
      throw AppError.internal('Unexpected response from Shopify', parsed.error);
    }
    return parsed.data;
  }
}
