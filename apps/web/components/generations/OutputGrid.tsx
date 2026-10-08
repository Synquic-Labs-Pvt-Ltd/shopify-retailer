import type { BatchItemView } from '@rs/shared';
import { resultTiles } from '@/lib/batch/outputs';
import { viewerTargetOf, type ViewerTarget } from './logic';
import { FailedTile, PendingTile, ReadyTile } from './OutputTile';
import styles from './generations.module.css';

interface OutputGridProps {
  item: BatchItemView;
  onOpen: (target: ViewerTarget) => void;
}

// Ready outputs first, then a placeholder per running job, then a tile per failed job.
export function OutputGrid({ item, onOpen }: OutputGridProps) {
  const tiles = resultTiles(item);
  if (tiles.length === 0) return <s-text color="subdued">Outputs appear here as soon as they are generated.</s-text>;

  const total = tiles.filter((tile) => tile.kind === 'output').length;
  return (
    <div className={styles.grid}>
      {tiles.map((tile, index) => {
        switch (tile.kind) {
          case 'output': {
            const target = viewerTargetOf(tile, item.id);
            return (
              <ReadyTile
                key={tile.media.id}
                media={tile.media}
                position={index + 1}
                total={total}
                onOpen={() => {
                  if (target !== null) onOpen(target);
                }}
              />
            );
          }
          case 'pending':
            return <PendingTile key={tile.key} tileKey={tile.key} />;
          case 'failed':
            return <FailedTile key={tile.key} jobType={tile.jobType} errorText={tile.errorText} />;
        }
      })}
    </div>
  );
}
