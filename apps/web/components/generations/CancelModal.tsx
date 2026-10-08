export const CANCEL_MODAL_ID = 'cancel-generation-modal';

interface CancelModalProps {
  onConfirm: () => void;
}

// Opened by a button with command="--show" and commandFor={CANCEL_MODAL_ID}. Both buttons close it again through
// command="--hide", so the page never has to track whether it is open.
export function CancelModal({ onConfirm }: CancelModalProps) {
  return (
    <s-modal id={CANCEL_MODAL_ID} heading="Cancel this generation?" size="small">
      <s-text>Jobs that are already running finish and keep their output. Everything else is cancelled.</s-text>
      <s-button
        slot="primary-action"
        variant="primary"
        tone="critical"
        commandFor={CANCEL_MODAL_ID}
        command="--hide"
        onClick={onConfirm}
      >
        Cancel generation
      </s-button>
      <s-button slot="secondary-actions" commandFor={CANCEL_MODAL_ID} command="--hide">
        Keep running
      </s-button>
    </s-modal>
  );
}
