import type { PromptVersionInfo } from '@rs/shared';
import { noteText, savedAtText, sizeText, versionActionLabel, versionLabel } from './logic';

interface VersionHistoryProps {
  // Newest first, the global default last.
  versions: readonly PromptVersionInfo[];
  // A save or a switch is running: versions cannot be activated meanwhile.
  disabled: boolean;
  onView: (version: number) => void;
  onActivate: (version: number) => void;
}

function VersionRow({
  version,
  disabled,
  onView,
  onActivate,
}: { version: PromptVersionInfo; disabled: boolean } & Pick<VersionHistoryProps, 'onView' | 'onActivate'>) {
  const name = version.version === 0 ? 'the global default' : `version ${version.version}`;
  return (
    <s-table-row>
      <s-table-cell>
        <s-text type="strong">{versionLabel(version.version)}</s-text>
      </s-table-cell>
      <s-table-cell>{savedAtText(version.createdAt)}</s-table-cell>
      <s-table-cell>{noteText(version)}</s-table-cell>
      <s-table-cell>{sizeText(version.chars)}</s-table-cell>
      <s-table-cell>{version.active ? <s-badge tone="success">Active</s-badge> : null}</s-table-cell>
      <s-table-cell>
        <s-stack direction="inline" alignItems="center" gap="small-200">
          <s-button variant="tertiary" accessibilityLabel={`View ${name}`} onClick={() => onView(version.version)}>
            View
          </s-button>
          {version.active ? null : (
            <s-button
              variant="tertiary"
              disabled={disabled}
              accessibilityLabel={`${versionActionLabel(version.version)}: ${name}`}
              onClick={() => onActivate(version.version)}
            >
              {versionActionLabel(version.version)}
            </s-button>
          )}
        </s-stack>
      </s-table-cell>
    </s-table-row>
  );
}

// Every version of the prompt in a table. The global default (v0) is always the last row and never changes.
export function VersionHistory({ versions, disabled, onView, onActivate }: VersionHistoryProps) {
  return (
    <s-table>
      <s-table-header-row>
        <s-table-header listSlot="primary">Version</s-table-header>
        <s-table-header listSlot="secondary">Saved</s-table-header>
        <s-table-header listSlot="labeled">Note</s-table-header>
        <s-table-header listSlot="labeled" format="numeric">
          Size (characters)
        </s-table-header>
        <s-table-header listSlot="inline">Status</s-table-header>
        <s-table-header listSlot="inline">Actions</s-table-header>
      </s-table-header-row>
      <s-table-body>
        {versions.map((version) => (
          <VersionRow
            key={version.version}
            version={version}
            disabled={disabled}
            onView={onView}
            onActivate={onActivate}
          />
        ))}
      </s-table-body>
    </s-table>
  );
}
