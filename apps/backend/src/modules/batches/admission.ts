import { Types } from 'mongoose';
import type { BatchLimitsConfig } from '@rs/shared';
import { AppError } from '../../core/errors';
import { BatchModel } from './models';

const ACTIVE_STATUSES = ['queued', 'running'] as const;

export function startOfUtcDay(at: Date): Date {
  return new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate()));
}

async function jobsCreatedToday(shopId: Types.ObjectId, now: Date): Promise<number> {
  const rows = await BatchModel.aggregate<{ total: number }>([
    { $match: { shopId, createdAt: { $gte: startOfUtcDay(now) } } },
    { $group: { _id: null, total: { $sum: '$counts.jobsTotal' } } },
  ]);
  return rows[0]?.total ?? 0;
}

// SPEC 10.6. Breaches return 429 shop_limit.
export async function assertAdmission(
  shopId: string,
  newBatch: { products: number; jobs: number },
  limits: BatchLimitsConfig,
  now: Date,
): Promise<void> {
  if (newBatch.products > limits.maxProductsPerBatch) {
    throw AppError.shopLimit(`A batch can have at most ${limits.maxProductsPerBatch} products`);
  }
  const shop = new Types.ObjectId(shopId);
  const active = await BatchModel.countDocuments({ shopId: shop, status: { $in: ACTIVE_STATUSES } });
  if (active >= limits.maxActiveBatchesPerShop) {
    throw AppError.shopLimit(`At most ${limits.maxActiveBatchesPerShop} generations can run at the same time. Wait for one to finish.`);
  }
  const used = await jobsCreatedToday(shop, now);
  if (used + newBatch.jobs > limits.maxJobsPerShopPerDay) {
    throw AppError.shopLimit(`The daily limit of ${limits.maxJobsPerShopPerDay} generation jobs would be exceeded. Try again tomorrow (UTC).`);
  }
}
