import { isTerminalJobStatus, type BatchItemView, type JobErrorCode, type JobType, type MediaObject } from '@rs/shared';

export type UsableOutput = MediaObject & { url: string };

// Outputs that can be shown and saved: ready, with a url. Images come first, then videos, each in the order
// they were produced.
export function usableOutputs(item: BatchItemView): UsableOutput[] {
  const rank = (media: MediaObject): number => (media.mediaType === 'image' ? 0 : 1);
  return item.outputs
    .filter((media): media is UsableOutput => media.status === 'ready' && media.url !== null)
    .sort((a, b) => rank(a) - rank(b) || a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
}

// "safety_blocked" -> "Safety blocked".
export function errorCodeText(code: JobErrorCode | null): string {
  if (code === null) return 'Unknown error';
  const words = code.replace(/_/g, ' ');
  return words.charAt(0).toUpperCase() + words.slice(1);
}

// One tile of the output grid of a product.
export type ResultTileModel =
  | { kind: 'output'; media: UsableOutput }
  | { kind: 'pending'; key: string }
  | { kind: 'failed'; key: string; jobType: JobType; errorCode: JobErrorCode | null; errorText: string };

// Outputs first, then a placeholder per job that is still running, then a critical tile per failed job.
// Plan jobs never show: a failed plan falls back to a deterministic plan on the server.
export function resultTiles(item: BatchItemView): ResultTileModel[] {
  const outputs = usableOutputs(item).map((media): ResultTileModel => ({ kind: 'output', media }));
  const shots = item.jobs.filter((job) => job.type !== 'plan');
  const pending = shots
    .filter((job) => !isTerminalJobStatus(job.status))
    .map((job): ResultTileModel => ({ kind: 'pending', key: `pending-${job.type}-${job.outputIndex ?? 0}` }));
  const failed = shots
    .filter((job) => job.status === 'failed')
    .map(
      (job): ResultTileModel => ({
        kind: 'failed',
        key: `failed-${job.type}-${job.outputIndex ?? 0}`,
        jobType: job.type,
        errorCode: job.errorCode,
        errorText: errorCodeText(job.errorCode),
      }),
    );
  return [...outputs, ...pending, ...failed];
}
