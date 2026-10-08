import { useEffect, useMemo, useRef } from 'react';
import type { BatchItemView } from '@rs/shared';
import { usableOutputs } from '@/lib/batch/outputs';
import type { DownloadItem } from '@/lib/download';
import { arrowKeyDelta, neighbourId, outputFilename, viewerCounter, viewerIndex } from './logic';
import { useModalOverlay, type ModalElement } from './overlay';
import styles from './generations.module.css';

export const VIEWER_MODAL_ID = 'media-viewer-modal';

interface MediaViewerProps {
  // The product being viewed, and the output shown. Both undefined or null: the viewer is closed.
  item: BatchItemView | undefined;
  mediaId: string | null;
  // A save of any kind is running.
  saving: boolean;
  onSelect: (mediaId: string) => void;
  onClose: () => void;
  onDownload: (file: DownloadItem) => void;
}

function isMediaElement(target: EventTarget | null): boolean {
  return target instanceof HTMLMediaElement;
}

// SPEC 16.2 MediaViewer: the outputs of one product in a large modal. Previous and next buttons or the left and
// right arrow keys step through them; Download saves the current one.
export function MediaViewer({ item, mediaId, saving, onSelect, onClose, onDownload }: MediaViewerProps) {
  const modalRef = useRef<ModalElement | null>(null);
  const outputs = useMemo(() => (item === undefined ? [] : usableOutputs(item)), [item]);
  const index = mediaId === null ? -1 : viewerIndex(outputs, mediaId);
  const current = outputs[index];
  const open = item !== undefined && current !== undefined;

  useModalOverlay(modalRef, open, onClose);

  const previousId = mediaId === null ? null : neighbourId(outputs, mediaId, -1);
  const nextId = mediaId === null ? null : neighbourId(outputs, mediaId, 1);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
      if (isMediaElement(event.target)) return;
      const delta = arrowKeyDelta(event.key);
      if (delta === null) return;
      const target = delta === 1 ? nextId : previousId;
      if (target === null) return;
      event.preventDefault();
      onSelect(target);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [open, previousId, nextId, onSelect]);

  const isVideo = current?.mediaType === 'video';
  const imageAlt = current?.shotTitle ?? item?.title ?? '';
  return (
    <s-modal ref={modalRef} id={VIEWER_MODAL_ID} heading={item?.title ?? 'Preview'} size="large-100">
      <div className={styles.stage}>
        {current === undefined ? null : isVideo ? (
          <video
            key={current.id}
            className={styles.media}
            src={current.url}
            poster={current.previewUrl ?? undefined}
            controls
            loop
            muted
            playsInline
            autoPlay
          />
        ) : (
          <img key={current.id} className={styles.media} src={current.url} alt={imageAlt} />
        )}
      </div>
      <div className={styles.viewerBar}>
        <s-button
          icon="chevron-left"
          accessibilityLabel="Previous"
          disabled={previousId === null}
          onClick={() => {
            if (previousId !== null) onSelect(previousId);
          }}
        />
        <span className={styles.counter} aria-live="polite">
          {index < 0 ? '' : viewerCounter(index, outputs.length)}
        </span>
        <s-button
          icon="chevron-right"
          accessibilityLabel="Next"
          disabled={nextId === null}
          onClick={() => {
            if (nextId !== null) onSelect(nextId);
          }}
        />
      </div>
      <s-button
        slot="primary-action"
        variant="primary"
        icon="download"
        disabled={current === undefined || saving}
        onClick={() => {
          if (item !== undefined && current !== undefined) {
            onDownload({ url: current.url, filename: outputFilename(item.title, current, index + 1) });
          }
        }}
      >
        Download
      </s-button>
      <s-button slot="secondary-actions" commandFor={VIEWER_MODAL_ID} command="--hide">
        Close
      </s-button>
    </s-modal>
  );
}
