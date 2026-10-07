import type { UpdateQuery } from 'mongoose';
import type { FileState } from './files-api';
import type { MediaAssetDoc } from './models';

type ReadyState = Extract<FileState, { status: 'ready' }>;
type FailedState = Extract<FileState, { status: 'failed' }>;

// Optional values are only written when Shopify returned them, so a document never holds nulls.
export function readyUpdate(state: ReadyState, now: Date): UpdateQuery<MediaAssetDoc> {
  return {
    $set: {
      status: 'ready',
      url: state.url,
      readyAt: now,
      ...(state.previewUrl === null ? {} : { previewUrl: state.previewUrl }),
      ...(state.width === null ? {} : { width: state.width }),
      ...(state.height === null ? {} : { height: state.height }),
      ...(state.durationSec === null ? {} : { durationSec: state.durationSec }),
    },
    $unset: { error: 1 },
  };
}

export function failedUpdate(state: Pick<FailedState, 'code' | 'message'>): UpdateQuery<MediaAssetDoc> {
  return { $set: { status: 'failed', error: { code: state.code, message: state.message } } };
}
