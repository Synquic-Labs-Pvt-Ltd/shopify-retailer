import type { ReferenceMode } from './enums';

export interface ResolvedReferences<T> {
  // 'none' means the product is unresolved and the batch is blocked (SPEC 9).
  mode: ReferenceMode | 'none';
  // Own references first, then common references. Each item appears once; upload order is kept.
  effective: T[];
}

// SPEC 9 resolution table. Used by the mobile app for the live rule display and by the batches module
// to enforce the same rule on the server.
export function resolveReferences<T>(own: readonly T[], common: readonly T[]): ResolvedReferences<T> {
  const effective = [...new Set([...own, ...common])];
  if (own.length > 0 && common.length > 0) return { mode: 'own_plus_common', effective };
  if (own.length > 0) return { mode: 'own_only', effective };
  if (common.length > 0) return { mode: 'common_only', effective };
  return { mode: 'none', effective: [] };
}
