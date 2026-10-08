import { ApiError, BATCH_STATUSES } from '@rs/shared';
import type { BatchCounts, BatchItemView, BatchJobView, BatchStatus, MediaObject } from '@rs/shared';
import { describe, expect, it } from 'vitest';
import { resultTiles, usableOutputs } from '@/lib/batch/outputs';
import type { ZipDownloadResult } from '@/lib/download';
import {
  BATCH_TABS,
  arrowKeyDelta,
  canCancelBatch,
  canRetryFailed,
  archiveGroupOf,
  archiveProgressLabel,
  archiveToast,
  batchArchiveFiles,
  failedTileTitle,
  filterByTab,
  isBatchNotFound,
  isValidBatchId,
  itemSummaryText,
  matchesTab,
  neighbourId,
  outputFilename,
  outputsReady,
  outputsTotal,
  pendingTileLabel,
  percentText,
  productArchiveFiles,
  readyText,
  singleDownloadToast,
  viewerCounter,
  viewerIndex,
  viewerTargetOf,
  zipProgressOf,
} from './logic';

const gid = 'gid://shopify/Product/1';

function media(id: number, overrides: Partial<MediaObject> = {}): MediaObject {
  return {
    id: id.toString(16).padStart(24, '0'),
    role: 'output',
    mediaType: 'image',
    status: 'ready',
    url: `https://cdn.shopify.com/s/files/out-${id}.jpg`,
    previewUrl: null,
    width: 1536,
    height: 2048,
    durationSec: null,
    filename: `out-${id}.jpg`,
    scope: null,
    productGid: gid,
    shotTitle: null,
    createdAt: `2026-03-10T12:00:0${id}.000Z`,
    ...overrides,
  };
}

const job = (overrides: Partial<BatchJobView>): BatchJobView => ({
  type: 'image',
  outputIndex: 0,
  status: 'queued',
  errorCode: null,
  ...overrides,
});

function item(title: string, outputs: MediaObject[], jobs: BatchJobView[] = []): BatchItemView {
  return {
    id: 'f'.repeat(24),
    productGid: gid,
    title,
    imageUrl: null,
    status: 'generating',
    referenceMode: 'common_only',
    outputs,
    jobs,
  };
}

function ready(overrides: Partial<MediaObject> = {}) {
  const output = usableOutputs(item('x', [media(1, overrides)]))[0];
  if (output === undefined) throw new Error('fixture is not usable');
  return output;
}

const counts = (overrides: Partial<BatchCounts>): BatchCounts => ({
  products: 1,
  jobsTotal: 4,
  jobsSucceeded: 0,
  jobsFailed: 0,
  jobsCancelled: 0,
  imagesReady: 0,
  videosReady: 0,
  ...overrides,
});

describe('tabs', () => {
  const statusesFor = (tab: (typeof BATCH_TABS)[number]): BatchStatus[] =>
    BATCH_STATUSES.filter((status) => matchesTab(status, tab));

  it('puts every status under All', () => {
    expect(statusesFor('all')).toEqual([...BATCH_STATUSES]);
  });

  it('puts queued and running batches under Running', () => {
    expect(statusesFor('running')).toEqual(['queued', 'running']);
  });

  it('puts only fully successful batches under Completed', () => {
    expect(statusesFor('completed')).toEqual(['completed']);
  });

  it('puts partial and failed batches under With errors', () => {
    expect(statusesFor('errors')).toEqual(['completed_with_errors', 'failed']);
  });

  it('filters a list and keeps its order', () => {
    const batches = [
      { id: 'a', status: 'completed' },
      { id: 'b', status: 'running' },
      { id: 'c', status: 'failed' },
      { id: 'd', status: 'running' },
    ] as const;
    expect(filterByTab(batches, 'running').map((batch) => batch.id)).toEqual(['b', 'd']);
    expect(filterByTab(batches, 'all')).toHaveLength(4);
    expect(filterByTab(batches, 'completed').map((batch) => batch.id)).toEqual(['a']);
  });
});

describe('batch actions', () => {
  it('offers Cancel only while the batch is not finished', () => {
    expect(canCancelBatch({ status: 'running' })).toBe(true);
    expect(canCancelBatch({ status: 'queued' })).toBe(true);
    expect(canCancelBatch({ status: 'completed' })).toBe(false);
    expect(canCancelBatch({ status: 'cancelled' })).toBe(false);
  });

  it('offers Retry failed only for a finished batch with failed jobs', () => {
    expect(canRetryFailed({ status: 'completed_with_errors', counts: counts({ jobsFailed: 2 }) })).toBe(true);
    expect(canRetryFailed({ status: 'completed_with_errors', counts: counts({ jobsFailed: 0 }) })).toBe(false);
    expect(canRetryFailed({ status: 'running', counts: counts({ jobsFailed: 2 }) })).toBe(false);
  });
});

describe('ids and errors', () => {
  it('accepts a 24 character hex id and nothing else', () => {
    expect(isValidBatchId('a'.repeat(24))).toBe(true);
    expect(isValidBatchId('A'.repeat(24))).toBe(false);
    expect(isValidBatchId('../etc/passwd')).toBe(false);
    expect(isValidBatchId('')).toBe(false);
  });

  it('treats a 404 and a validation failure as not found', () => {
    expect(isBatchNotFound(new ApiError(404, 'not_found', 'No such batch'))).toBe(true);
    expect(isBatchNotFound(new ApiError(400, 'validation_failed', 'Bad id'))).toBe(true);
    expect(isBatchNotFound(new ApiError(500, 'internal', 'Boom'))).toBe(false);
    expect(isBatchNotFound(new ApiError(0, 'network_error', 'Offline'))).toBe(false);
    expect(isBatchNotFound(new Error('x'))).toBe(false);
  });
});

describe('counts text', () => {
  it('lists images and videos and skips a zero part', () => {
    expect(readyText({ imagesReady: 5, videosReady: 2 })).toBe('5 images, 2 videos');
    expect(readyText({ imagesReady: 1, videosReady: 0 })).toBe('1 image');
    expect(readyText({ imagesReady: 0, videosReady: 1 })).toBe('1 video');
    expect(readyText({ imagesReady: 0, videosReady: 0 })).toBe('None yet');
  });

  it('rounds the progress to a percent within 0 to 100', () => {
    expect(percentText(0.578)).toBe('58%');
    expect(percentText(1)).toBe('100%');
    expect(percentText(0)).toBe('0%');
    expect(percentText(1.4)).toBe('100%');
    expect(percentText(-1)).toBe('0%');
  });

  it('counts outputs ready against products times outputs per product', () => {
    const batch = {
      counts: counts({ products: 4, imagesReady: 4, videosReady: 2 }),
      configSnapshot: { outputs: { imagesPerProduct: 2, videosPerProduct: 1 } },
    };
    expect(outputsReady(batch.counts)).toBe(6);
    expect(outputsTotal(batch)).toBe(12);
  });
});

describe('itemSummaryText', () => {
  it('reads ready over expected', () => {
    const product = item('Lamp', [media(1), media(2)], [job({ status: 'succeeded' })]);
    expect(itemSummaryText(product, 3)).toBe('2 of 3 ready');
  });

  it('adds the failed shots and ignores a failed plan job', () => {
    const product = item('Lamp', [media(1)], [
      job({ type: 'plan', outputIndex: null, status: 'failed' }),
      job({ type: 'video', status: 'failed', errorCode: 'safety_blocked' }),
    ]);
    expect(itemSummaryText(product, 3)).toBe('1 of 3 ready, 1 failed');
  });

  it('never shows more ready than expected', () => {
    expect(itemSummaryText(item('Lamp', [media(1), media(2)]), 1)).toBe('2 of 2 ready');
    expect(itemSummaryText(item('Lamp', [media(1)]), 0)).toBe('1 ready');
  });
});

describe('outputFilename', () => {
  it('joins product, shot title, index and extension', () => {
    const output = ready({ shotTitle: 'Front view' });
    expect(outputFilename('Linen camp-collar shirt', output, 2)).toBe('Linen-camp-collar-shirt-Front-view-2.jpg');
  });

  it('uses the media type when there is no shot title', () => {
    const video = ready({ mediaType: 'video', url: 'https://cdn.shopify.com/v/clip.MP4?v=123' });
    expect(outputFilename('Tote', video, 1)).toBe('Tote-video-1.mp4');
  });

  it('takes the extension from the url, then the stored name, then the media type', () => {
    expect(outputFilename('A', ready({ url: 'https://cdn.shopify.com/o/img.webp?x=1' }), 1)).toBe('A-image-1.webp');
    expect(outputFilename('A', ready({ url: 'https://cdn.shopify.com/o/img', filename: 'shot.png' }), 1)).toBe(
      'A-image-1.png',
    );
    expect(outputFilename('A', ready({ url: 'https://cdn.shopify.com/o/img', filename: 'shot' }), 1)).toBe(
      'A-image-1.jpg',
    );
    expect(
      outputFilename('A', ready({ mediaType: 'video', url: 'https://cdn.shopify.com/o/clip', filename: 'clip' }), 1),
    ).toBe('A-video-1.mp4');
  });

  it('drops accents, symbols and path characters, and falls back for an empty title', () => {
    expect(outputFilename('Crème brûlée / set: 2!', ready(), 1)).toBe('Creme-brulee-set-2-image-1.jpg');
    expect(outputFilename('???', ready({ shotTitle: '../..' }), 3)).toBe('product-image-3.jpg');
  });

  it('keeps a long title within the length limit and keeps the extension', () => {
    const name = outputFilename('x'.repeat(300), ready(), 1);
    expect(name.length).toBeLessThanOrEqual(120);
    expect(name.endsWith('-image-1.jpg')).toBe(true);
  });
});

describe('zip contents', () => {
  const video = media(1, { mediaType: 'video', url: 'https://cdn.shopify.com/v/a.mp4', filename: 'a.mp4' });
  const image = media(2, { shotTitle: 'Detail' });

  it('names the outputs of a product like the single downloads, images first', () => {
    const product = item('Mug', [video, image]);
    expect(archiveGroupOf(product)).toEqual({
      title: 'Mug',
      files: [
        { url: image.url, filename: 'Mug-Detail-1.jpg' },
        { url: video.url, filename: 'Mug-video-2.mp4' },
      ],
    });
  });

  it('puts every product of a batch in a folder named after it', () => {
    const first = item('Linen shirt', [media(1), media(2, { status: 'processing' })]);
    const second = { ...item('Tote bag', [media(3)]), id: 'e'.repeat(24) };
    expect(batchArchiveFiles({ items: [first, second] })).toEqual([
      { url: media(1).url, path: 'Linen-shirt/Linen-shirt-image-1.jpg' },
      { url: media(3).url, path: 'Tote-bag/Tote-bag-image-1.jpg' },
    ]);
  });

  it('keeps products with the same title apart and leaves out products without outputs', () => {
    const one = item('Mug', [media(1)]);
    const two = { ...item('Mug', [media(2)]), id: 'e'.repeat(24) };
    const none = { ...item('Empty', []), id: 'd'.repeat(24) };
    expect(batchArchiveFiles({ items: [one, none, two] }).map((file) => file.path)).toEqual([
      'Mug/Mug-image-1.jpg',
      'Mug-2/Mug-image-1.jpg',
    ]);
    expect(batchArchiveFiles({ items: [] })).toEqual([]);
  });

  it('zips one product with its own folder and skips outputs that are not ready', () => {
    const product = item('Mug', [media(1), media(2, { status: 'processing' }), media(3, { url: null })]);
    expect(productArchiveFiles(product)).toEqual([{ url: media(1).url, path: 'Mug/Mug-image-1.jpg' }]);
    expect(productArchiveFiles(item('Mug', []))).toEqual([]);
  });
});

describe('zip progress and toasts', () => {
  const zip = (overrides: Partial<ZipDownloadResult>): ZipDownloadResult => ({
    outcome: 'saved',
    total: 9,
    added: 9,
    skipped: [],
    ...overrides,
  });

  it('labels the file being fetched, never past the last one', () => {
    expect(archiveProgressLabel(0, 9)).toBe('Preparing 1 of 9 files...');
    expect(archiveProgressLabel(3, 9)).toBe('Preparing 4 of 9 files...');
    expect(archiveProgressLabel(9, 9)).toBe('Preparing 9 of 9 files...');
  });

  it('shows the progress only on the button of the zip that is being built', () => {
    const archive = { scope: 'item-1', done: 1, total: 4 };
    expect(zipProgressOf(archive, 'item-1')).toBe('Preparing 2 of 4 files...');
    expect(zipProgressOf(archive, 'item-2')).toBeNull();
    expect(zipProgressOf(archive, 'batch')).toBeNull();
    expect(zipProgressOf(null, 'item-1')).toBeNull();
  });

  it('confirms a complete zip by name', () => {
    expect(archiveToast(zip({}), 'retailer-studio-a1b2c3.zip')).toEqual({
      message: 'Saved retailer-studio-a1b2c3.zip with 9 files',
      isError: false,
    });
    expect(archiveToast(zip({ added: 1, total: 1 }), 'Mug.zip')?.message).toBe('Saved Mug.zip with 1 file');
  });

  it('names the files that were left out of a partly filled zip', () => {
    expect(archiveToast(zip({ added: 7, skipped: ['Mug/a.jpg', 'Mug/b.mp4'] }), 'Mug.zip')).toEqual({
      message: 'Saved 7 of 9 files in Mug.zip. Could not download a.jpg, b.mp4.',
      isError: true,
    });
    const many = ['x/1.jpg', 'x/2.jpg', 'x/3.jpg', 'x/4.jpg', 'x/5.jpg'];
    expect(archiveToast(zip({ added: 4, skipped: many }), 'x.zip')?.message).toBe(
      'Saved 4 of 9 files in x.zip. Could not download 1.jpg, 2.jpg, 3.jpg and 2 more.',
    );
  });

  it('is an error when nothing could be fetched, the zip is too large, and silent when cancelled', () => {
    expect(archiveToast(zip({ outcome: 'failed', added: 0, skipped: ['a/1.jpg'] }), 'x.zip')).toEqual({
      message: 'Could not download the files. Try again.',
      isError: true,
    });
    expect(archiveToast(zip({ outcome: 'too_large' }), 'x.zip')?.isError).toBe(true);
    expect(archiveToast(zip({ outcome: 'cancelled' }), 'x.zip')).toBeNull();
  });

  it('says where the zip went when the browser refused to save it', () => {
    expect(archiveToast(zip({ outcome: 'opened' }), 'x.zip')).toEqual({
      message: 'Could not save the zip, it was opened in a new tab',
      isError: false,
    });
  });
});

describe('download toasts', () => {
  it('names the single file outcomes', () => {
    expect(singleDownloadToast('saved')).toEqual({ message: 'Saved', isError: false });
    expect(singleDownloadToast('opened')).toEqual({
      message: 'Could not save the file, it was opened in a new tab',
      isError: false,
    });
    expect(singleDownloadToast('failed').isError).toBe(true);
  });
});

describe('viewer navigation', () => {
  const outputs = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];

  it('finds the index of a media id', () => {
    expect(viewerIndex(outputs, 'b')).toBe(1);
    expect(viewerIndex(outputs, 'zzz')).toBe(-1);
  });

  it('steps to the neighbours and stops at both ends', () => {
    expect(neighbourId(outputs, 'b', 1)).toBe('c');
    expect(neighbourId(outputs, 'b', -1)).toBe('a');
    expect(neighbourId(outputs, 'c', 1)).toBeNull();
    expect(neighbourId(outputs, 'a', -1)).toBeNull();
    expect(neighbourId(outputs, 'zzz', 1)).toBeNull();
    expect(neighbourId([], 'a', 1)).toBeNull();
  });

  it('formats the counter from one', () => {
    expect(viewerCounter(0, 6)).toBe('1 / 6');
    expect(viewerCounter(5, 6)).toBe('6 / 6');
  });

  it('maps the arrow keys and nothing else', () => {
    expect(arrowKeyDelta('ArrowRight')).toBe(1);
    expect(arrowKeyDelta('ArrowLeft')).toBe(-1);
    expect(arrowKeyDelta('ArrowUp')).toBeNull();
    expect(arrowKeyDelta('a')).toBeNull();
  });
});

describe('tiles', () => {
  const product = item(
    'Vest',
    [media(1), media(2)],
    [
      job({ type: 'plan', outputIndex: null, status: 'succeeded' }),
      job({ type: 'image', outputIndex: 0, status: 'succeeded' }),
      job({ type: 'image', outputIndex: 1, status: 'running' }),
      job({ type: 'video', outputIndex: 0, status: 'queued' }),
      job({ type: 'video', outputIndex: 1, status: 'failed', errorCode: 'safety_blocked' }),
    ],
  );
  const tiles = resultTiles(product);

  it('opens the viewer only from a ready tile', () => {
    const targets = tiles.map((tile) => viewerTargetOf(tile, 'item-1'));
    expect(targets).toEqual([
      { itemId: 'item-1', mediaId: media(1).id },
      { itemId: 'item-1', mediaId: media(2).id },
      null,
      null,
      null,
    ]);
  });

  it('labels pending and failed tiles by media type', () => {
    const pending = tiles.filter((tile) => tile.kind === 'pending').map((tile) => pendingTileLabel(tile.key));
    expect(pending).toEqual(['Image in progress', 'Video in progress']);
    expect(failedTileTitle('video')).toBe('Video failed');
    expect(failedTileTitle('image')).toBe('Image failed');
  });
});
