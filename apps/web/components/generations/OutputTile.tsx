import type { JobType } from '@rs/shared';
import { formatDuration } from '@/lib/batch/format';
import type { UsableOutput } from '@/lib/batch/outputs';
import { failedTileTitle, pendingTileLabel } from './logic';
import styles from './generations.module.css';

function PlayGlyph() {
  return (
    <svg className={styles.play} viewBox="0 0 36 36" aria-hidden="true">
      <circle cx="18" cy="18" r="17" fill="rgba(26, 26, 26, 0.55)" />
      <path d="M14.5 11.5 25 18l-10.5 6.5Z" fill="#fff" />
    </svg>
  );
}

interface ReadyTileProps {
  media: UsableOutput;
  // 1-based place among the ready outputs of the product.
  position: number;
  total: number;
  onOpen: () => void;
}

// A ready output. A video shows its poster (when the server has one) with a play glyph and its length. An output
// that was added to its Shopify product says so.
export function ReadyTile({ media, position, total, onOpen }: ReadyTileProps) {
  const isVideo = media.mediaType === 'video';
  const source = isVideo ? media.previewUrl : (media.previewUrl ?? media.url);
  const shot = media.shotTitle === null ? '' : `, ${media.shotTitle}`;
  return (
    <button
      type="button"
      className={styles.tile}
      onClick={onOpen}
      aria-label={`Open ${isVideo ? 'video' : 'image'} ${position} of ${total}${shot}`}
    >
      {source === null ? null : <img className={styles.image} src={source} alt="" loading="lazy" decoding="async" />}
      {isVideo ? <PlayGlyph /> : null}
      {media.attachedAt === null || media.attachedAt === undefined ? null : (
        <span className={styles.attached}>On product</span>
      )}
      {isVideo && media.durationSec !== null ? (
        <span className={styles.duration}>{formatDuration(media.durationSec)}</span>
      ) : null}
    </button>
  );
}

export function PendingTile({ tileKey }: { tileKey: string }) {
  return <div className={`${styles.tile} ${styles.pending}`}>{pendingTileLabel(tileKey)}</div>;
}

// The tile has room for a few words (errorText); the full explanation is its tooltip and is also listed under the grid.
export function FailedTile({ jobType, errorText, errorDetail }: { jobType: JobType; errorText: string; errorDetail: string }) {
  return (
    <div className={`${styles.tile} ${styles.failed}`} title={errorDetail}>
      <s-icon type="alert-circle" tone="critical" />
      <span className={styles.failedTitle}>{failedTileTitle(jobType)}</span>
      <span className={styles.failedText}>{errorText}</span>
    </div>
  );
}
