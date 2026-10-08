import { ITEM_ATTACHED_LABEL, ITEM_ATTACH_LABEL, type AttachState } from './attach';
import { DOWNLOAD_PRODUCT_LABEL } from './logic';

interface ItemActionsProps {
  // Ready outputs of the product; the zip has nothing to hold without them.
  outputCount: number;
  attachState: AttachState;
  // This product's request to add its outputs is running.
  attaching: boolean;
  // Another request or save is running: the buttons wait.
  busy: boolean;
  // Set while this product's zip is being built, for example "Preparing 2 of 5 files...".
  zipProgress: string | null;
  onDownload: () => void;
  onAttach: () => void;
}

// Under the header of a product: "Download (.zip)" and "Add to product". Nothing shows before the first output.
export function ItemActions({ outputCount, attachState, attaching, busy, zipProgress, onDownload, onAttach }: ItemActionsProps) {
  if (outputCount === 0) return null;
  return (
    <s-stack direction="inline" alignItems="center" gap="small-200">
      <s-button icon="download" loading={zipProgress !== null} disabled={busy} onClick={onDownload}>
        {zipProgress ?? DOWNLOAD_PRODUCT_LABEL}
      </s-button>
      {attachState === 'done' ? (
        <s-badge tone="success">{ITEM_ATTACHED_LABEL}</s-badge>
      ) : attachState === 'ready' ? (
        <s-button loading={attaching} disabled={busy} onClick={onAttach}>
          {ITEM_ATTACH_LABEL}
        </s-button>
      ) : null}
    </s-stack>
  );
}
