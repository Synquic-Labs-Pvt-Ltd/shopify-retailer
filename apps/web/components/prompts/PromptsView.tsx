'use client';

import { useRouter } from 'next/navigation';
import type { PromptSummary } from '@rs/shared';
import { ScreenReaderText, SkeletonBar } from '@/components/generations/Skeleton';
import { errorMessage } from '@/lib/api/errors';
import { usePrompts } from '@/lib/api/hooks';
import { lastEditedText, promptBadge } from './logic';

const SKELETON_ROWS = [0, 1, 2] as const;
const SKELETON_WIDTHS = [260, 100, 110, 56] as const;

function SkeletonRows() {
  return SKELETON_ROWS.map((row) => (
    <s-table-row key={row}>
      {SKELETON_WIDTHS.map((width, column) => (
        <s-table-cell key={column}>
          <SkeletonBar width={width} />
          {row === 0 && column === 0 ? <ScreenReaderText>Loading prompts</ScreenReaderText> : null}
        </s-table-cell>
      ))}
    </s-table-row>
  ));
}

function PromptRow({ prompt, onEdit }: { prompt: PromptSummary; onEdit: () => void }) {
  const badge = promptBadge(prompt.activeVersion);
  return (
    <s-table-row>
      <s-table-cell>
        <s-stack gap="small-500">
          <s-text type="strong">{prompt.title}</s-text>
          <s-text color="subdued">{prompt.description}</s-text>
        </s-stack>
      </s-table-cell>
      <s-table-cell>
        <s-badge tone={badge.tone}>{badge.label}</s-badge>
      </s-table-cell>
      <s-table-cell>{lastEditedText(prompt.updatedAt) ?? '—'}</s-table-cell>
      <s-table-cell>
        <s-button accessibilityLabel={`Edit ${prompt.title}`} onClick={onEdit}>
          Edit
        </s-button>
      </s-table-cell>
    </s-table-row>
  );
}

// SPEC 12.6 Prompts: the three prompts of the generation pipeline with the version this store runs on.
export function PromptsView() {
  const router = useRouter();
  const query = usePrompts();
  const loadFailed = query.isError && query.data === undefined;

  return (
    <s-page heading="Prompts">
      {loadFailed ? (
        <s-banner tone="critical" heading="Could not load your prompts">
          {errorMessage(query.error)}
          <s-button slot="secondary-actions" onClick={() => void query.refetch()}>
            Retry
          </s-button>
        </s-banner>
      ) : (
        <s-section padding="none">
          <s-box padding="base">
            <s-paragraph color="subdued">
              These prompts tell the AI how to plan and make your images and videos. Changes apply to this store only and
              never touch the global defaults. Every save keeps a version, so you can go back to any earlier one or to the
              global default.
            </s-paragraph>
          </s-box>
          <s-table>
            <s-table-header-row>
              <s-table-header listSlot="primary">Prompt</s-table-header>
              <s-table-header listSlot="inline">Status</s-table-header>
              <s-table-header listSlot="secondary">Last edited</s-table-header>
              <s-table-header listSlot="inline">Actions</s-table-header>
            </s-table-header-row>
            <s-table-body>
              {query.isPending ? (
                <SkeletonRows />
              ) : (
                (query.data?.items ?? []).map((prompt) => (
                  <PromptRow key={prompt.name} prompt={prompt} onEdit={() => router.push(`/prompts/${prompt.name}`)} />
                ))
              )}
            </s-table-body>
          </s-table>
        </s-section>
      )}
    </s-page>
  );
}
