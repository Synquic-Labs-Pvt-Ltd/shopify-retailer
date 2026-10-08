'use client';

import { useRouter } from 'next/navigation';
import { useMemo, useState } from 'react';
import { useProducts } from '@/lib/api/hooks';
import { errorMessage } from '@/lib/api/errors';
import type { ProductStatusTab } from '@/lib/api/products';
import { SEARCH_DEBOUNCE_MS, emptyCopy, productFilterKey, selectionDetail } from './logic';
import {
  clampPageIndex,
  hasNextPage,
  hasPreviousPage,
  nextStep,
  positionFor,
  previousPageIndex,
  type PagePosition,
  type PageWindow,
} from './pagination';
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

// SPEC 16.2 Products: search, status tabs, a paged table and the selection that feeds New generation. The search and
// the tabs are filters of the products API; the table shows one cursor page at a time.
export function ProductsView() {
  const router = useRouter();
  const { hydrated, maxProducts } = useDraftSession();
  const [search, setSearch] = useState('');
  const [tab, setTab] = useState<ProductStatusTab>('all');
  const debouncedSearch = useDebouncedValue(search, SEARCH_DEBOUNCE_MS);
  const query = useProducts(debouncedSearch, tab);

  // The page on show restarts at the first one for every new search or tab. The position is replaced while rendering,
  // which React re-renders at once, so no frame shows the old page number on the new list.
  const filterKey = productFilterKey(debouncedSearch, tab);
  const [position, setPosition] = useState<PagePosition>({ key: filterKey, index: 0 });
  if (position.key !== filterKey) setPosition({ key: filterKey, index: 0 });
  const pages = query.data?.pages;
  const loadedPages = pages?.length ?? 0;
  const pageIndex = clampPageIndex(positionFor(position, filterKey), loadedPages);
  const listed = useMemo(() => pages?.[pageIndex]?.items ?? [], [pages, pageIndex]);
  const pageWindow: PageWindow = { pageIndex, loadedPages, serverHasMore: query.hasNextPage };
  const selection = useProductSelection(listed, { search: debouncedSearch, tab }, maxProducts);

  const goPrevious = (): void => setPosition({ key: filterKey, index: previousPageIndex(pageIndex) });
  const goNext = (): void => {
    const step = nextStep(pageWindow);
    if (step.kind === 'show') {
      setPosition({ key: filterKey, index: step.pageIndex });
    } else if (step.kind === 'fetch' && !query.isFetchingNextPage) {
      // The page arrives at index step.pageIndex. If the search or tab changed meanwhile, the position is ignored.
      void query.fetchNextPage().then((result) => {
        if ((result.data?.pages.length ?? 0) > step.pageIndex) setPosition({ key: filterKey, index: step.pageIndex });
      });
    }
  };

  const searching = debouncedSearch.trim() !== '';
  const hasNext = hasNextPage(pageWindow);
  const hasPrevious = hasPreviousPage(pageWindow);
  const loaded = query.data !== undefined;
  // A failed refetch keeps the products that were already loaded and shows the banner above them.
  const loadError = query.isError && !query.isFetchNextPageError;
  // Products without an image are left out, so a page can be empty while others hold products: the empty state is
  // only for a search and tab without any product to show. An empty page among others keeps the table to move on.
  const pageEmpty = loaded && listed.length === 0;
  const showEmpty = pageEmpty && !hasNext && !hasPrevious;
  const copy = emptyCopy({ searching, tab, hasMore: hasNext, hasPrevious });

  return (
    <s-page heading="Products">
      <s-section padding="none">
        <ProductsToolbar tab={tab} onTabChange={setTab} search={search} onSearchChange={setSearch} />
        {selection.count > 0 || selection.busy !== null ? (
          <SelectionBar
            count={selection.count}
            detail={selectionDetail(selection.summary)}
            busy={selection.busy}
            onClear={selection.clear}
            onGenerate={() => router.push('/generate')}
          />
        ) : null}

        {loadError ? (
          <ErrorBanner
            message={errorMessage(query.error, 'Could not load your products.')}
            onRetry={() => void query.refetch()}
          />
        ) : null}
        {selection.failure !== null ? (
          <ErrorBanner
            message={errorMessage(selection.failure.error, 'Could not select the products.')}
            onRetry={selection.retry}
          />
        ) : null}
        {showEmpty ? (
          <s-box padding="base">
            <s-empty-state heading={copy.heading}>
              <s-paragraph>{copy.body}</s-paragraph>
            </s-empty-state>
          </s-box>
        ) : loaded || query.isPending ? (
          <>
            {pageEmpty ? (
              <s-box padding="base">
                <s-text color="subdued">
                  {copy.heading}. {copy.body}
                </s-text>
              </s-box>
            ) : null}
            <ProductsTable
              items={listed}
              loading={query.isPending}
              busy={query.isFetchingNextPage}
              hasPreviousPage={hasPrevious}
              hasNextPage={hasNext}
              onPreviousPage={goPrevious}
              onNextPage={goNext}
              selectedIds={selection.selectedIds}
              headerState={selection.headerState}
              disabled={!hydrated}
              selecting={selection.busy !== null}
              onToggle={selection.setSelected}
              onToggleAll={selection.setAllSelected}
            />
          </>
        ) : null}

        {query.isFetchNextPageError ? (
          <ErrorBanner message={errorMessage(query.error, 'Could not load the next page.')} onRetry={goNext} />
        ) : null}
      </s-section>
    </s-page>
  );
}
