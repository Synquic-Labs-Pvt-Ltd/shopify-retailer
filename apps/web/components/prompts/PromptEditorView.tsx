'use client';

import { useRouter } from 'next/navigation';
import { useMemo, useState } from 'react';
import {
  PROMPT_DEFINITIONS,
  PROMPT_NOTE_MAX_CHARS,
  isPromptName,
  validatePromptText,
  type PromptName,
} from '@rs/shared';
import { errorMessage, validationErrors } from '@/lib/api/errors';
import { useActivatePrompt, usePrompt, useSavePrompt } from '@/lib/api/hooks';
import { showToast } from '@/lib/shopify';
import { PlaceholderPanel } from './PlaceholderPanel';
import { PromptNoteField, PromptTextArea } from './PromptFields';
import { DiscardChangesModal, RESET_MODAL_ID, ResetPromptModal } from './PromptModals';
import { VersionHistory } from './VersionHistory';
import { VersionPreview } from './VersionPreview';
import {
  activeVersionBadge,
  canSavePrompt,
  charCountText,
  insertPlaceholder,
  isDirty,
  knownVersionText,
  latestVersionText,
  mergeErrors,
  orderedVersions,
  placeholderStatuses,
} from './logic';

function BackLink() {
  return (
    <s-link slot="breadcrumb-actions" href="/prompts">
      Prompts
    </s-link>
  );
}

function NotFound() {
  const router = useRouter();
  return (
    <s-page heading="Prompt">
      <BackLink />
      <s-section>
        <s-empty-state heading="Prompt not found">
          <s-paragraph>There is no prompt with this name. Pick one from the list.</s-paragraph>
          <s-button slot="primary-action" variant="primary" onClick={() => router.push('/prompts')}>
            Back to prompts
          </s-button>
        </s-empty-state>
      </s-section>
    </s-page>
  );
}

function Loading({ heading }: { heading: string }) {
  return (
    <s-page heading={heading}>
      <BackLink />
      <s-section>
        <s-stack alignItems="center" justifyContent="center">
          <s-spinner size="large" accessibilityLabel="Loading prompt" />
        </s-stack>
      </s-section>
    </s-page>
  );
}

function LoadFailed({ heading, error, onRetry }: { heading: string; error: unknown; onRetry: () => void }) {
  return (
    <s-page heading={heading}>
      <BackLink />
      <s-banner tone="critical" heading="Could not load this prompt">
        {errorMessage(error)}
        <s-button slot="secondary-actions" onClick={onRetry}>
          Retry
        </s-button>
      </s-banner>
    </s-page>
  );
}

function ProblemList({ problems }: { problems: readonly string[] }) {
  const heading =
    problems.length === 1 ? 'Fix this to save the prompt' : `Fix these ${problems.length} problems to save the prompt`;
  return (
    <s-banner tone="critical" heading={heading}>
      <s-unordered-list>
        {problems.map((problem) => (
          <s-list-item key={problem}>{problem}</s-list-item>
        ))}
      </s-unordered-list>
    </s-banner>
  );
}

// SPEC 12.6 prompt editor: the active text of one prompt of this store, with live validation, versions saved on
// every save, and a way back to any version or to the global default.
function PromptEditor({ name }: { name: PromptName }) {
  const definition = PROMPT_DEFINITIONS[name];
  const query = usePrompt(name);
  const save = useSavePrompt(name);
  const activate = useActivatePrompt(name);
  // What the merchant typed or loaded into the editor. Null while the editor simply shows the active version, so a
  // switch of version (or a save) shows the new text without any copying, and edits are never replaced silently.
  const [edited, setEdited] = useState<string | null>(null);
  const [note, setNote] = useState('');
  // The version open in the read-only preview.
  const [viewing, setViewing] = useState<number | null>(null);
  // A switch that waits for the answer to "Discard unsaved changes?".
  const [pendingSwitch, setPendingSwitch] = useState<number | null>(null);

  const detail = query.data;
  const loadedText = detail?.text ?? '';
  const draft = edited ?? loadedText;
  const validation = useMemo(() => validatePromptText(name, draft), [name, draft]);
  const statuses = useMemo(() => placeholderStatuses(name, draft), [name, draft]);

  if (detail === undefined) {
    return query.isError ? (
      <LoadFailed heading={definition.title} error={query.error} onRetry={() => void query.refetch()} />
    ) : (
      <Loading heading={definition.title} />
    );
  }

  const dirty = edited !== null && isDirty(edited, loadedText);
  const working = save.isPending || activate.isPending;
  const canSave = canSavePrompt({ dirty, valid: validation.ok, busy: working });
  const serverProblems = validationErrors(save.error);
  const problems = mergeErrors(validation.ok ? [] : validation.errors, serverProblems ?? []);
  // A failed save that is not about the text (the version limit, the connection).
  const saveFailure = save.isError && serverProblems === null ? save.error : null;
  const status = activeVersionBadge(detail.activeVersion);
  const versions = orderedVersions(detail.versions);

  const edit = (text: string): void => {
    setEdited(text);
    // The problems the server named belong to the text that was sent.
    if (save.isError) save.reset();
  };

  const saveVersion = (): void => {
    const trimmed = note.trim();
    save.mutate(
      { text: draft, note: trimmed === '' ? undefined : trimmed },
      {
        onSuccess: (saved) => {
          setEdited(null);
          setNote('');
          showToast(`Saved as version ${saved.activeVersion} and activated`);
        },
        // Problems with the text are in the banner already.
        onError: (error) => {
          if (validationErrors(error) === null) showToast(errorMessage(error, 'Could not save the prompt.'), true);
        },
      },
    );
  };

  // Makes a version the active one. The editor then shows its text: whatever was in it has been dealt with by now.
  const switchTo = (version: number): void => {
    activate.mutate(
      { version },
      {
        onSuccess: () => {
          setEdited(null);
          setNote('');
          save.reset();
          showToast(version === 0 ? 'Using the global default' : `Version ${version} is now active`);
        },
        onError: (error) => showToast(errorMessage(error, 'Could not switch the version.'), true),
      },
    );
  };

  const requestSwitch = (version: number): void => {
    if (dirty) setPendingSwitch(version);
    else switchTo(version);
  };

  const confirmSwitch = (): void => {
    const version = pendingSwitch;
    setPendingSwitch(null);
    if (version !== null) switchTo(version);
  };

  const discard = (): void => {
    setEdited(null);
    setNote('');
    save.reset();
  };

  const loadIntoEditor = (text: string): void => {
    edit(text);
    setViewing(null);
    showToast(
      isDirty(text, loadedText)
        ? 'Loaded into the editor. Save it as a new version to keep it.'
        : 'That text is already in the editor.',
    );
  };

  return (
    <>
      <s-page heading={definition.title}>
        <BackLink />
        <s-button
          slot="primary-action"
          variant="primary"
          disabled={!canSave}
          loading={save.isPending}
          onClick={saveVersion}
        >
          Save as new version
        </s-button>
        {dirty ? (
          <s-button slot="secondary-actions" disabled={working} onClick={discard}>
            Discard changes
          </s-button>
        ) : null}
        {detail.isCustom ? (
          <s-button
            slot="secondary-actions"
            commandFor={RESET_MODAL_ID}
            command="--show"
            disabled={working}
            loading={activate.isPending && activate.variables?.version === 0}
          >
            Reset to global default
          </s-button>
        ) : null}

        <s-stack direction="inline" alignItems="center" gap="small-200">
          <s-badge tone={status.tone}>{status.label}</s-badge>
          <s-text color="subdued">{latestVersionText(detail.latestVersion)}</s-text>
          {dirty ? <s-badge tone="caution">Unsaved changes</s-badge> : null}
        </s-stack>
        <s-paragraph color="subdued">{definition.description}</s-paragraph>

        {saveFailure === null ? null : (
          <s-banner tone="critical" heading="Could not save the prompt">
            {errorMessage(saveFailure)}
          </s-banner>
        )}

        <s-section heading="Prompt text">
          <s-stack gap="base">
            {problems.length > 0 ? <ProblemList problems={problems} /> : null}
            <PromptTextArea label="Prompt text" value={draft} rows={24} details={charCountText(draft)} onChange={edit} />
            <PromptNoteField
              value={note}
              maxLength={PROMPT_NOTE_MAX_CHARS}
              disabled={working}
              onChange={setNote}
            />
          </s-stack>
        </s-section>

        <s-section heading="Version history" padding="none">
          <VersionHistory versions={versions} disabled={working} onView={setViewing} onActivate={requestSwitch} />
        </s-section>

        {viewing === null ? null : (
          <VersionPreview
            key={viewing}
            name={name}
            version={viewing}
            info={detail.versions.find((version) => version.version === viewing)}
            knownText={knownVersionText(detail, viewing)}
            busy={working}
            onLoad={loadIntoEditor}
            onClose={() => setViewing(null)}
          />
        )}

        <PlaceholderPanel
          statuses={statuses}
          disabled={working}
          onInsert={(placeholder) => edit(insertPlaceholder(draft, placeholder))}
        />
      </s-page>

      <ResetPromptModal dirty={dirty} onConfirm={() => switchTo(0)} />
      <DiscardChangesModal version={pendingSwitch} onConfirm={confirmSwitch} onCancel={() => setPendingSwitch(null)} />
    </>
  );
}

// /prompts/:name. A name that is not one of the three prompts gets a not-found page without any request.
export function PromptEditorView({ name }: { name: string }) {
  return isPromptName(name) ? <PromptEditor key={name} name={name} /> : <NotFound />;
}
