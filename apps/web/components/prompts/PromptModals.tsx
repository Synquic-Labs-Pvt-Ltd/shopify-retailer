'use client';

import { useRef } from 'react';
import { useModalOverlay, type ModalElement } from '@/components/generations/overlay';

export const RESET_MODAL_ID = 'reset-prompt-modal';

interface ResetPromptModalProps {
  // The editor holds changes that were not saved: the reset throws them away too.
  dirty: boolean;
  onConfirm: () => void;
}

// Opened by a button with command="--show" and commandFor={RESET_MODAL_ID}, like the cancel dialog of a generation.
export function ResetPromptModal({ dirty, onConfirm }: ResetPromptModalProps) {
  return (
    <s-modal id={RESET_MODAL_ID} heading="Reset to the global default?" size="small">
      <s-stack gap="small-200">
        <s-text>
          This store goes back to the global prompt (v0). The versions you saved stay in the history, so you can switch
          back to any of them.
        </s-text>
        {dirty ? <s-text>The changes in the editor that you have not saved will be discarded.</s-text> : null}
      </s-stack>
      <s-button slot="primary-action" variant="primary" commandFor={RESET_MODAL_ID} command="--hide" onClick={onConfirm}>
        Reset to global default
      </s-button>
      <s-button slot="secondary-actions" commandFor={RESET_MODAL_ID} command="--hide">
        Keep the current version
      </s-button>
    </s-modal>
  );
}

export const DISCARD_MODAL_ID = 'discard-prompt-changes-modal';

interface DiscardChangesModalProps {
  // The version the merchant asked to switch to while the editor held unsaved changes; null closes the dialog.
  version: number | null;
  onConfirm: () => void;
  onCancel: () => void;
}

// Asks before a switch replaces unsaved edits. It is opened from state, because the click that asks for it only needs
// a confirmation when the editor is dirty.
export function DiscardChangesModal({ version, onConfirm, onCancel }: DiscardChangesModalProps) {
  const ref = useRef<ModalElement | null>(null);
  useModalOverlay(ref, version !== null, onCancel);
  const target = version === 0 ? 'the global default' : `version ${version ?? ''}`;

  return (
    <s-modal ref={ref} id={DISCARD_MODAL_ID} heading="Discard unsaved changes?" size="small">
      <s-text>
        Switching to {target} replaces the text in the editor. The changes you have not saved are lost.
      </s-text>
      <s-button
        slot="primary-action"
        variant="primary"
        tone="critical"
        commandFor={DISCARD_MODAL_ID}
        command="--hide"
        onClick={onConfirm}
      >
        Discard and switch
      </s-button>
      <s-button slot="secondary-actions" commandFor={DISCARD_MODAL_ID} command="--hide">
        Keep editing
      </s-button>
    </s-modal>
  );
}
