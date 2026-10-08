import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import { endpoints } from '@/lib/api/endpoints';
import { showToast } from '@/lib/shopify';
import { useDraftStore, type DraftProduct } from '@/lib/state';
import { deepLinkMessage, parseProductIds } from './logic';

async function preselect(raw: string, maxProducts: number): Promise<void> {
  const parsed = parseProductIds(raw, maxProducts);
  const results = await Promise.allSettled(parsed.ids.map((id) => endpoints.products.get(id)));

  const loaded: DraftProduct[] = [];
  let failed = 0;
  for (const result of results) {
    if (result.status === 'fulfilled') {
      loaded.push({ id: result.value.id, title: result.value.title, imageUrl: result.value.featuredImageUrl });
    } else {
      failed += 1;
    }
  }

  const draft = useDraftStore.getState();
  const dropped = loaded.length > 0 ? draft.setProducts([...draft.products, ...loaded], maxProducts) : 0;
  const message = deepLinkMessage({ invalid: parsed.invalid, truncated: parsed.truncated, failed, dropped });
  if (message !== null) showToast(message, true);
}

function hasIdsParameter(): boolean {
  return typeof window !== 'undefined' && new URLSearchParams(window.location.search).has('ids');
}

// The address without `ids`; the other parameters the Shopify admin adds (shop, host) stay.
function addressWithoutIds(): string {
  const params = new URLSearchParams(window.location.search);
  params.delete('ids');
  const rest = params.toString();
  return rest === '' ? '/generate' : `/generate?${rest}`;
}

// /generate?ids=gid1,gid2 preselects those products (a Shopify admin action opens the app this way). It runs
// once, when the draft is loaded and bound to the shop, then removes the parameter so a reload does not repeat it.
// Returns true while the products are being fetched, so the page can show a skeleton instead of an empty selection.
export function useDeepLinkProducts(ready: boolean, maxProducts: number): boolean {
  const router = useRouter();
  const started = useRef(false);
  const [loading, setLoading] = useState(hasIdsParameter);

  useEffect(() => {
    if (!ready || started.current) return;
    started.current = true;
    const raw = new URLSearchParams(window.location.search).get('ids');
    if (raw === null) {
      setLoading(false);
      return;
    }
    void preselect(raw, maxProducts).finally(() => {
      setLoading(false);
      router.replace(addressWithoutIds());
    });
  }, [ready, maxProducts, router]);

  return loading;
}
