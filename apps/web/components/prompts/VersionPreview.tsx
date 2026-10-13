'use client';

import type { PromptName, PromptVersionInfo } from '@rs/shared';
import { errorMessage } from '@/lib/api/errors';
import { usePromptVersion } from '@/lib/api/hooks';
import { PromptTextArea } from './PromptFields';
import { noteText, savedAtText } from './logic';

interface VersionPreviewProps {
  name: PromptName;
  version: number;
  // What the version table says about it; undefined when the table no longer lists it.
  info: PromptVersionInfo | undefined;
  // The text when it is already at hand (the active version, the global default); null to fetch it.
  knownText: string | null;
  // A save or a switch is running.
  busy: boolean;
  onLoad: (text: string) => void;
  onClose: () => void;
}

// A read-only look at one version, with a button that puts its text in the editor. Loading it never saves anything.
export function VersionPreview({ name, version, info, knownText, busy, onLoad, onClose }: VersionPreviewProps) {
  const query = usePromptVersion(name, version, knownText === null);
  const text = knownText ?? query.data?.text ?? null;
  const heading = version === 0 ? 'Global default (v0)' : `Version ${version}`;

  return (
    <s-section heading={heading}>
      <s-button slot="secondary-actions" onClick={onClose}>
        Close
      </s-button>
      <s-button slot="primary-action" disabled={text === null || busy} onClick={() => text !== null && onLoad(text)}>
        Load into editor
      </s-button>
      <s-stack gap="base">
        {info === undefined ? null : (
          <s-text color="subdued">{`Saved ${savedAtText(info.createdAt)} · ${noteText(info)}`}</s-text>
        )}
        {text !== null ? (
          <PromptTextArea label="Text of this version (read only)" value={text} rows={14} />
        ) : query.isError ? (
          <s-banner tone="critical" heading="Could not load this version">
            {errorMessage(query.error)}
            <s-button slot="secondary-actions" onClick={() => void query.refetch()}>
              Retry
            </s-button>
          </s-banner>
        ) : (
          <s-stack direction="inline" alignItems="center" gap="small-200">
            <s-spinner accessibilityLabel="Loading this version" />
            <s-text color="subdued">Loading this version</s-text>
          </s-stack>
        )}
        <s-text color="subdued">
          Loading it into the editor does not save anything. Save the editor to make it a new version.
        </s-text>
      </s-stack>
    </s-section>
  );
}
