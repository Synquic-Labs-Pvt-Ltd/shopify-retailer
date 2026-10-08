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

interface JobErrorText {
  // Fits the failed tile (about 116 px wide, three short lines).
  short: string;
  // One sentence saying what happened and what to do, shown under the product's outputs.
  detail: string;
}

const UNKNOWN_ERROR: JobErrorText = {
  short: 'Unknown error',
  detail: 'The reason is unknown. Use Retry failed to try again.',
};

const JOB_ERROR_TEXT: Record<JobErrorCode, JobErrorText> = {
  rate_limited: {
    short: 'AI service was busy',
    detail: 'The AI service was too busy to take this request. Use Retry failed to try again.',
  },
  daily_quota: {
    short: 'Daily quota used up',
    detail: 'The daily generation quota was used up. It resets automatically; retry after it resets.',
  },
  provider_unavailable: {
    short: 'AI service unavailable',
    detail:
      'The AI service is unavailable right now (billing or access issue on the provider side). Retry later or contact support.',
  },
  auth_error: {
    short: 'AI service refused access',
    detail: 'The AI service did not accept the credentials the app uses. Retry later or contact support.',
  },
  transient: {
    short: 'Temporary error',
    detail: 'A temporary error interrupted this result. Use Retry failed to try again.',
  },
  invalid_request: {
    short: 'Request was rejected',
    detail:
      'The AI service rejected this request, usually because of the product or reference images. Try other references and retry.',
  },
  safety_blocked: {
    short: 'Blocked by safety filters',
    detail: "The AI provider's safety filters blocked this result. Try a different reference style or retry.",
  },
  no_output: {
    short: 'No result returned',
    detail: 'The AI service finished without returning a result. Use Retry failed to try again.',
  },
  timeout: {
    short: 'AI service took too long',
    detail: 'The AI provider took too long to respond. Use Retry failed to try again.',
  },
  lease_expired: {
    short: 'Interrupted',
    detail: 'This job was interrupted before it finished. Use Retry failed to try again.',
  },
  quota_timeout: {
    short: 'Waited too long for capacity',
    detail: 'This job waited too long for generation capacity. Use Retry failed to try again later.',
  },
  shopify_upload_failed: {
    short: 'Could not save to Shopify',
    detail: 'Could not save the result to your Shopify files. Check app permissions and retry.',
  },
  cancelled: { short: 'Cancelled', detail: 'This job was cancelled.' },
  internal: {
    short: 'Unexpected error',
    detail: 'Something went wrong on our side. Use Retry failed to try again, or contact support if it keeps happening.',
  },
};

const errorTextOf = (code: JobErrorCode | null): JobErrorText => (code === null ? UNKNOWN_ERROR : JOB_ERROR_TEXT[code]);

// The text of a failed tile: short enough for the tile. "Blocked by safety filters".
export function errorCodeText(code: JobErrorCode | null): string {
  return errorTextOf(code).short;
}

// What happened and what to do about it, in one sentence.
export function errorCodeDetail(code: JobErrorCode | null): string {
  return errorTextOf(code).detail;
}

// One tile of the output grid of a product.
export type ResultTileModel =
  | { kind: 'output'; media: UsableOutput }
  | { kind: 'pending'; key: string }
  | {
      kind: 'failed';
      key: string;
      jobType: JobType;
      errorCode: JobErrorCode | null;
      errorText: string;
      errorDetail: string;
    };

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
        errorDetail: errorCodeDetail(job.errorCode),
      }),
    );
  return [...outputs, ...pending, ...failed];
}

// The distinct explanations of the failed tiles, in the order they first appear: what the merchant should read
// under the grid, since the tiles only have room for a few words.
export function failureNotes(tiles: readonly ResultTileModel[]): string[] {
  const notes = tiles.flatMap((tile) => (tile.kind === 'failed' ? [tile.errorDetail] : []));
  return [...new Set(notes)];
}
