'use client';

import type { DraftReference } from '@/lib/state/draftTypes';
import { formatDuration } from './logic';
import styles from './references.module.css';

interface ReferenceSlotProps {
  reference: DraftReference;
  // A failed slot can start over only while its file is still in memory.
  retryable: boolean;
  onRetry: (clientId: string) => void;
  onRemove: (clientId: string) => void;
}

function PlayGlyph() {
  return (
    <svg width="10" height="10" viewBox="0 0 10 10" fill="currentColor" aria-hidden="true">
      <path d="M2 1.2v7.6L8.6 5 2 1.2Z" />
    </svg>
  );
}

function CloseGlyph() {
  return (
    <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" aria-hidden="true">
      <path d="m2 2 6 6M8 2 2 8" />
    </svg>
  );
}

// One 56 x 70 tile per reference: uploading (progress), processing (spinner), ready (preview), failed (red
// outline, with Retry when the file is still available). Every state can be removed.
export function ReferenceSlot({ reference, retryable, onRetry, onRemove }: ReferenceSlotProps) {
  const { clientId, filename, mediaType, status, previewUrl, progress, durationSec } = reference;
  const showPreview = previewUrl !== null && status !== 'failed';
  const duration = formatDuration(durationSec);

  return (
    <li className={status === 'failed' ? `${styles.tile} ${styles.tileFailed}` : styles.tile}>
      {showPreview ? (
        <img
          className={status === 'ready' ? styles.preview : `${styles.preview} ${styles.dimmed}`}
          src={previewUrl}
          alt={status === 'ready' ? filename : ''}
        />
      ) : null}

      {status === 'ready' && previewUrl === null ? (
        <span className={styles.center}>
          <s-icon type={mediaType === 'video' ? 'video' : 'image'} />
        </span>
      ) : null}
      {status === 'ready' && mediaType === 'video' ? (
        <>
          <span className={styles.play}>
            <PlayGlyph />
          </span>
          {duration !== '' ? <span className={styles.duration}>{duration}</span> : null}
        </>
      ) : null}

      {status === 'uploading' ? (
        <div className={styles.progress}>
          <s-progress value={Math.round(progress * 100)} max={100} accessibilityLabel={`Uploading ${filename}`} />
        </div>
      ) : null}
      {status === 'processing' ? (
        <span className={styles.center}>
          <s-spinner size="base" accessibilityLabel={`Processing ${filename}`} />
        </span>
      ) : null}

      {status === 'failed' && retryable ? (
        <button type="button" className={styles.retry} onClick={() => onRetry(clientId)} aria-label={`Retry ${filename}`}>
          Retry
        </button>
      ) : null}
      {status === 'failed' && !retryable ? <span className={styles.failedLabel}>Failed</span> : null}

      <button type="button" className={styles.remove} onClick={() => onRemove(clientId)} aria-label={`Remove ${filename}`}>
        <CloseGlyph />
      </button>
    </li>
  );
}
