import type { BatchItemView, BatchJobView, MediaObject } from '@rs/shared';
import { describe, expect, it } from 'vitest';
import { errorCodeText, resultTiles, usableOutputs } from './outputs';

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

function item(outputs: MediaObject[], jobs: BatchJobView[]): BatchItemView {
  return {
    id: 'f'.repeat(24),
    productGid: gid,
    title: 'Lamp',
    imageUrl: null,
    status: 'generating',
    referenceMode: 'common_only',
    outputs,
    jobs,
  };
}

describe('usableOutputs', () => {
  it('keeps ready outputs with a url and puts images before videos', () => {
    const video = media(1, { mediaType: 'video', filename: 'v.mp4', durationSec: 8 });
    const lateImage = media(4);
    const earlyImage = media(2);
    const processing = media(3, { status: 'processing' });
    const noUrl = media(5, { url: null });
    const result = usableOutputs(item([video, lateImage, processing, noUrl, earlyImage], []));
    expect(result.map((output) => output.id)).toEqual([earlyImage.id, lateImage.id, video.id]);
  });

  it('orders by createdAt and falls back to the id', () => {
    const a = media(2, { createdAt: '2026-03-10T12:00:00.000Z' });
    const b = media(1, { createdAt: '2026-03-10T12:00:00.000Z' });
    const c = media(3, { createdAt: '2026-03-09T12:00:00.000Z' });
    expect(usableOutputs(item([a, b, c], [])).map((output) => output.id)).toEqual([c.id, b.id, a.id]);
  });

  it('does not reorder the item it reads', () => {
    const outputs = [media(2), media(1)];
    usableOutputs(item(outputs, []));
    expect(outputs.map((output) => output.id)).toEqual([media(2).id, media(1).id]);
  });
});

describe('resultTiles', () => {
  it('lists outputs, then one pending tile per unfinished shot, then failed tiles', () => {
    const output = media(1);
    const tiles = resultTiles(
      item(
        [output],
        [
          job({ type: 'plan', outputIndex: null, status: 'running' }),
          job({ type: 'image', outputIndex: 0, status: 'succeeded' }),
          job({ type: 'image', outputIndex: 1, status: 'running' }),
          job({ type: 'video', outputIndex: 0, status: 'failed', errorCode: 'safety_blocked' }),
          job({ type: 'video', outputIndex: 1, status: 'awaiting_operation' }),
          job({ type: 'image', outputIndex: 2, status: 'blocked' }),
        ],
      ),
    );
    expect(tiles).toEqual([
      { kind: 'output', media: output },
      { kind: 'pending', key: 'pending-image-1' },
      { kind: 'pending', key: 'pending-video-1' },
      { kind: 'pending', key: 'pending-image-2' },
      { kind: 'failed', key: 'failed-video-0', jobType: 'video', errorCode: 'safety_blocked', errorText: 'Safety blocked' },
    ]);
  });

  it('never shows plan jobs, even a failed one, and skips cancelled shots', () => {
    const tiles = resultTiles(
      item(
        [],
        [
          job({ type: 'plan', outputIndex: null, status: 'failed', errorCode: 'internal' }),
          job({ type: 'image', status: 'cancelled', errorCode: 'cancelled' }),
        ],
      ),
    );
    expect(tiles).toEqual([]);
  });

  it('gives a failed job without a code the unknown error text', () => {
    const [tile] = resultTiles(item([], [job({ type: 'image', outputIndex: null, status: 'failed' })]));
    expect(tile).toEqual({ kind: 'failed', key: 'failed-image-0', jobType: 'image', errorCode: null, errorText: 'Unknown error' });
  });

  it('shows no tile for an item with nothing to show', () => {
    expect(resultTiles(item([], []))).toEqual([]);
  });
});

describe('errorCodeText', () => {
  it('capitalises and spaces the code', () => {
    expect(errorCodeText('safety_blocked')).toBe('Safety blocked');
    expect(errorCodeText('shopify_upload_failed')).toBe('Shopify upload failed');
    expect(errorCodeText('timeout')).toBe('Timeout');
    expect(errorCodeText(null)).toBe('Unknown error');
  });
});
