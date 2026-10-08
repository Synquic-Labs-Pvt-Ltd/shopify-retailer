import { JOB_ERROR_CODES, type BatchItemView, type BatchJobView, type MediaObject } from '@rs/shared';
import { describe, expect, it } from 'vitest';
import { errorCodeDetail, errorCodeText, failureNotes, resultTiles, usableOutputs } from './outputs';

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
      {
        kind: 'failed',
        key: 'failed-video-0',
        jobType: 'video',
        errorCode: 'safety_blocked',
        errorText: 'Blocked by safety filters',
        errorDetail: "The AI provider's safety filters blocked this result. Try a different reference style or retry.",
      },
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
    expect(tile).toEqual({
      kind: 'failed',
      key: 'failed-image-0',
      jobType: 'image',
      errorCode: null,
      errorText: 'Unknown error',
      errorDetail: 'The reason is unknown. Use Retry failed to try again.',
    });
  });

  it('shows no tile for an item with nothing to show', () => {
    expect(resultTiles(item([], []))).toEqual([]);
  });
});

describe('error texts', () => {
  it('explains the errors the merchant can act on in a full sentence', () => {
    expect(errorCodeDetail('daily_quota')).toBe(
      'The daily generation quota was used up. It resets automatically; retry after it resets.',
    );
    expect(errorCodeDetail('provider_unavailable')).toBe(
      'The AI service is unavailable right now (billing or access issue on the provider side). Retry later or contact support.',
    );
    expect(errorCodeDetail('safety_blocked')).toBe(
      "The AI provider's safety filters blocked this result. Try a different reference style or retry.",
    );
    expect(errorCodeDetail('timeout')).toBe('The AI provider took too long to respond. Use Retry failed to try again.');
    expect(errorCodeDetail('shopify_upload_failed')).toBe(
      'Could not save the result to your Shopify files. Check app permissions and retry.',
    );
  });

  it('has a short tile text and a one sentence explanation for every error code', () => {
    for (const code of JOB_ERROR_CODES) {
      const short = errorCodeText(code);
      const detail = errorCodeDetail(code);
      // The tile is 116 px wide inside its padding: a few short lines at most.
      expect(short.length).toBeGreaterThan(0);
      expect(short.length).toBeLessThanOrEqual(30);
      expect(short).not.toMatch(/_/);
      expect(detail).toMatch(/^[A-Z].*[.]$/);
      expect(detail).not.toMatch(/_/);
      expect(detail.length).toBeGreaterThan(short.length);
    }
  });

  it('gives every error code its own explanation', () => {
    const details = JOB_ERROR_CODES.map(errorCodeDetail);
    expect(new Set(details).size).toBe(details.length);
    expect(errorCodeDetail('daily_quota')).toMatch(/resets/);
    expect(errorCodeDetail('provider_unavailable')).toMatch(/contact support/);
    expect(errorCodeDetail('safety_blocked')).toMatch(/different reference/);
  });

  it('knows what to say for a failed job without a code', () => {
    expect(errorCodeText(null)).toBe('Unknown error');
    expect(errorCodeDetail(null)).toMatch(/Retry failed/);
  });
});

describe('failureNotes', () => {
  it('lists each distinct explanation once, in the order the failures appear', () => {
    const tiles = resultTiles(
      item(
        [],
        [
          job({ type: 'image', outputIndex: 0, status: 'failed', errorCode: 'timeout' }),
          job({ type: 'image', outputIndex: 1, status: 'failed', errorCode: 'safety_blocked' }),
          job({ type: 'video', outputIndex: 0, status: 'failed', errorCode: 'timeout' }),
          job({ type: 'image', outputIndex: 2, status: 'running' }),
        ],
      ),
    );
    expect(failureNotes(tiles)).toEqual([errorCodeDetail('timeout'), errorCodeDetail('safety_blocked')]);
  });

  it('is empty when nothing failed', () => {
    expect(failureNotes(resultTiles(item([media(1)], [job({ status: 'succeeded' })])))).toEqual([]);
    expect(failureNotes([])).toEqual([]);
  });
});
