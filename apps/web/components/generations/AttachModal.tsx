import { ATTACH_MODAL_BODY, ATTACH_MODAL_HEADING, BATCH_ATTACH_LABEL, attachConfirmText } from './attach';

export const ATTACH_MODAL_ID = 'attach-media-modal';

interface AttachModalProps {
  // Products that would get new media.
  productCount: number;
  onConfirm: () => void;
}

// Asked before the batch-level "Add to products", which changes the store. Opened by a button with command="--show"
// and commandFor={ATTACH_MODAL_ID}; both buttons close it through command="--hide" (see CancelModal).
export function AttachModal({ productCount, onConfirm }: AttachModalProps) {
  return (
    <s-modal id={ATTACH_MODAL_ID} heading={ATTACH_MODAL_HEADING} size="small">
      <s-stack gap="small">
        <s-text>{ATTACH_MODAL_BODY}</s-text>
        <s-text>{attachConfirmText(productCount)}</s-text>
      </s-stack>
      <s-button
        slot="primary-action"
        variant="primary"
        commandFor={ATTACH_MODAL_ID}
        command="--hide"
        onClick={onConfirm}
      >
        {BATCH_ATTACH_LABEL}
      </s-button>
      <s-button slot="secondary-actions" commandFor={ATTACH_MODAL_ID} command="--hide">
        Not now
      </s-button>
    </s-modal>
  );
}
