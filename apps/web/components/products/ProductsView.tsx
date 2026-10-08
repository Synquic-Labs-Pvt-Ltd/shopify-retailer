'use client';

import { useRouter } from 'next/navigation';
import { useMemo, useState } from 'react';
import { useProducts } from '@/lib/api/hooks';
import { errorMessage } from '@/lib/api/errors';
import { pageItems } from '@/lib/api/pages';
import { filterProductsByStatus, type ProductStatusTab } from '@/lib/api/products';
import { SEARCH_DEBOUNCE_MS, emptyCopy } from './logic';
import { ProductsTable } from './ProductsTable';
import { ProductsToolbar } from './ProductsToolbar';
import { SelectionBar } from './SelectionBar';
import { useDebouncedValue } from './useDebouncedValue';
import { useDraftSession } from './useDraftSession';
import { useProductSelection } from './useProductSelection';

function ErrorBanner({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <s-box padding="base">
      <s-banner tone="critical" heading={message}>
        <s-button slot="secondary-actions" onClick={onRetry}>
          Retry
        </s-button>
      </s-banner>
    </s-box>
  );
}

// SPEC 16.2 Products: search, status tabs, infinite loading and the selection that feeds New generation.
export function ProductsView() {
  const router = useRouter();
  const { hydrated, maxProducts } = useDraftSession();
  const [search, setSearch] = useState('');
  const [tab, setTab] = useState<ProductStatusTab>('all');
  const debouncedSearch = useDebouncedValue(search, SEARCH_DEBOUNCE_MS);
  const query = useProducts(debouncedSearch);

  const items = useMemo(() => pageItems(query.data), [query.data]);
  const listed = useMemo(() => filterProductsByStatus(items, tab), [items, tab]);
  const selection = useProductSelection(listed, maxProducts);

  const searching = debouncedSearch.trim() !== '';
  const hasMore = query.hasNextPage;
  const loaded = query.data !== undefined;
  // A failed refetch keeps the products that were already loaded and shows the banner above them.
  const loadError = query.isError && !query.isFetchNextPageError;
  const showEmpty = loaded && listed.length === 0;
  const copy = emptyCopy({ searching, tab, hasMore });

  return (
    <s-page heading="Products">
      <s-section padding="none">
        <ProductsToolbar tab={tab} onTabChange={setTab} search={search} onSearchChange={setSearch} />
        {selection.count > 0 ? (
          <SelectionBar count={selection.count} onClear={selection.clear} onGenerate={() => router.push('/generate')} />
        ) : null}

        {loadError ? (
          <ErrorBanner
            message={errorMessage(query.error, 'Could not load your products.')}
            onRetry={() => void query.refetch()}
          />
        ) : null}
        {showEmpty ? (
          <s-box padding="base">
            <s-empty-state heading={copy.heading}>
              <s-paragraph>{copy.body}</s-paragraph>
            </s-empty-state>
          </s-box>
        ) : loaded || query.isPending ? (
          <ProductsTable
            items={listed}
            loading={query.isPending}
            selectedIds={selection.selectedIds}
            headerState={selection.headerState}
            disabled={!hydrated}
            onToggle={selection.setSelected}
            onToggleAll={selection.setAllSelected}
          />
        ) : null}

        {query.isFetchNextPageError ? (
          <ErrorBanner
            message={errorMessage(query.error, 'Could not load more products.')}
            onRetry={() => void query.fetchNextPage()}
          />
        ) : null}
        {loaded && hasMore ? (
          <s-box padding="base">
            <s-stack direction="inline" justifyContent="center">
              <s-button
                loading={query.isFetchingNextPage}
                disabled={query.isFetchingNextPage}
                onClick={() => void query.fetchNextPage()}
              >
                Load more
              </s-button>
            </s-stack>
          </s-box>
        ) : null}
      </s-section>
    </s-page>
  );
}
