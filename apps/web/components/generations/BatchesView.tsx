'use client';

import { useMemo, useState } from 'react';
import { errorMessage } from '@/lib/api/errors';
import { useBatches } from '@/lib/api/hooks';
import { pageItems } from '@/lib/api/pages';
import { plural } from '@/lib/batch/format';
import { BatchTable } from './BatchTable';
import { BatchTabs } from './BatchTabs';
import { filterByTab, type BatchTab } from './logic';

function EmptyList() {
  return (
    <s-empty-state heading="No generations yet">
      <s-text slot="subheading">Pick products and add references to create your first generation.</s-text>
      <s-button slot="primary-action" variant="primary" href="/products">
        Select products
      </s-button>
    </s-empty-state>
  );
}

// SPEC 16.2 Queue: every batch with its progress. The hooks poll while any loaded batch is still running.
export function BatchesView() {
  const query = useBatches();
  const [tab, setTab] = useState<BatchTab>('all');
  const batches = useMemo(() => pageItems(query.data), [query.data]);
  const visible = useMemo(() => filterByTab(batches, tab), [batches, tab]);

  const loadFailed = query.isError && query.data === undefined;
  const empty = query.isSuccess && batches.length === 0;
  const retry = () => void query.refetch();

  return (
    <s-page heading="Generations">
      <s-button slot="primary-action" variant="primary" href="/products">
        New generation
      </s-button>

      {loadFailed ? (
        <s-banner tone="critical" heading="Could not load your generations">
          {errorMessage(query.error)}
          <s-button slot="secondary-actions" onClick={retry}>
            Retry
          </s-button>
        </s-banner>
      ) : null}

      {query.isRefetchError ? (
        <s-banner tone="warning" heading="Could not refresh the list">
          The generations below may be out of date.
          <s-button slot="secondary-actions" onClick={retry}>
            Try again
          </s-button>
        </s-banner>
      ) : null}

      {loadFailed ? null : (
        <s-section padding={empty ? 'base' : 'none'}>
          {empty ? (
            <EmptyList />
          ) : (
            <>
              <BatchTabs tab={tab} onChange={setTab} />
              <BatchTable batches={visible} loading={query.isPending} />
              {query.isPending ? null : (
                <s-box padding="base">
                  {visible.length === 0 ? (
                    <s-text color="subdued">
                      {query.hasNextPage
                        ? 'No loaded generations match this filter. Load more to keep looking.'
                        : 'No generations match this filter.'}
                    </s-text>
                  ) : null}
                  <s-stack direction="inline" alignItems="center" justifyContent="center" gap="base">
                    <s-text color="subdued">
                      {tab === 'all'
                        ? plural(batches.length, 'generation')
                        : `${visible.length} of ${batches.length} loaded generations`}
                    </s-text>
                    {query.hasNextPage ? (
                      <s-button loading={query.isFetchingNextPage} onClick={() => void query.fetchNextPage()}>
                        Load more
                      </s-button>
                    ) : null}
                  </s-stack>
                  {query.isFetchNextPageError ? (
                    <s-banner tone="critical" heading="Could not load more generations">
                      {errorMessage(query.error)}
                    </s-banner>
                  ) : null}
                </s-box>
              )}
            </>
          )}
        </s-section>
      )}
    </s-page>
  );
}
