import { resolveReferences, type CreateBatchRequest, type ReferenceMode, type ReferencesConfig } from '@rs/shared';
import { AppError } from '../../core/errors';
import type { MediaAssetRecord } from '../media';

export interface ResolvedProduct {
  productGid: string;
  own: string[];
  effective: string[];
  mode: ReferenceMode;
}

export interface ResolvedRequest {
  common: string[];
  products: ResolvedProduct[];
}

const unique = (ids: readonly string[]): string[] => [...new Set(ids)];

// SPEC 9, enforced again by the server: caps first (400), then the resolution table (422 for any
// product without a reference). Ids are checked against the shop separately, see assertUsableReferences.
export function resolveRequest(request: CreateBatchRequest, limits: ReferencesConfig): ResolvedRequest {
  const common = unique(request.commonReferenceMediaIds);
  if (common.length > limits.maxCommon) {
    throw AppError.validation(`At most ${limits.maxCommon} common references are allowed`, { maxCommon: limits.maxCommon });
  }

  const products: ResolvedProduct[] = [];
  const unresolved: string[] = [];
  for (const product of request.products) {
    const own = unique(product.referenceMediaIds);
    if (own.length > limits.maxPerProduct) {
      throw AppError.validation(`At most ${limits.maxPerProduct} references are allowed per product`, {
        productGid: product.productGid,
        maxPerProduct: limits.maxPerProduct,
      });
    }
    const resolved = resolveReferences(own, common);
    if (resolved.mode === 'none') unresolved.push(product.productGid);
    else products.push({ productGid: product.productGid, own, effective: resolved.effective, mode: resolved.mode });
  }
  if (unresolved.length > 0) throw AppError.referencesRequired(unresolved);
  return { common, products };
}

// SPEC 9: a reference must belong to the shop, have role reference and be ready.
export function assertUsableReferences(mediaIds: readonly string[], assets: readonly MediaAssetRecord[]): void {
  const byId = new Map(assets.map((asset) => [asset.id, asset]));
  const unusable = mediaIds.filter((id) => {
    const asset = byId.get(id);
    return asset === undefined || asset.role !== 'reference' || asset.status !== 'ready';
  });
  if (unusable.length > 0) {
    throw AppError.validation('Every reference must be one of your ready reference uploads', { mediaIds: unusable });
  }
}

export function allReferenceIds(resolved: ResolvedRequest): string[] {
  return unique([...resolved.common, ...resolved.products.flatMap((product) => product.own)]);
}
