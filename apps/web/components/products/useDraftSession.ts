import { useEffect } from 'react';
import { useMe } from '@/lib/api/hooks';
import { useDraftHydration, useDraftStore } from '@/lib/state';
import { DEFAULT_MAX_PRODUCTS } from './logic';

// What both pages need before they show the draft: the persisted draft is read, and it is bound to the shop
// that /me reports (a draft never carries over to another shop).
export function useDraftSession() {
  const hydrated = useDraftHydration();
  const me = useMe();
  const shopId = me.data?.shop.id;

  useEffect(() => {
    if (hydrated && shopId !== undefined) useDraftStore.getState().bindShop(shopId);
  }, [hydrated, shopId]);

  return { hydrated, me, maxProducts: me.data?.generation.maxProductsPerBatch ?? DEFAULT_MAX_PRODUCTS };
}
