import { describe, expect, it } from 'vitest';
import { createDraftStore } from '@/lib/state/draft';
import { createMemoryStorage } from '@/lib/state/draftStorage';
import { createFileRegistry } from '@/lib/state/fileRegistry';
import {
  createProcessingTracker,
  PROCESSING_TIMEOUT_MESSAGE,
  PROCESSING_TIMEOUT_MS,
  processingRefs,
} from './processing';
import { mediaObject, slot } from './testkit';
import { PROCESSING_FAILED_MESSAGE } from './uploadService';

function setup() {
  const store = createDraftStore({ storage: createMemoryStorage(), files: createFileRegistry() });
  const gid = 'gid://shopify/Product/1';
  store.getState().addRef({ kind: 'common' }, slot('c1', { status: 'processing', mediaId: 'm1', progress: 1 }));
  store.getState().addRef({ kind: 'common' }, slot('c2', { status: 'ready', mediaId: 'm2', progress: 1 }));
  store.getState().addRef({ kind: 'product', productId: gid }, slot('p1', { status: 'processing', mediaId: 'm3' }));
  store.getState().addRef({ kind: 'product', productId: gid }, slot('p2', { status: 'uploading' }));
  const status = (id: string) =>
    [...store.getState().commonRefs, ...Object.values(store.getState().productRefs).flat()].find(
      (ref) => ref.clientId === id,
    );
  return { store, status };
}

describe('processingRefs', () => {
  it('lists the processing slots that have a media id', () => {
    const { store } = setup();
    expect(processingRefs(store.getState()).map((ref) => ref.mediaId)).toEqual(['m1', 'm3']);
  });
});

describe('createProcessingTracker', () => {
  it('settles slots from a poll result', () => {
    const { store, status } = setup();
    const tracker = createProcessingTracker();
    const failures = tracker.apply(store, [
      mediaObject('m1', 'ready', { previewUrl: 'https://cdn/1.jpg' }),
      mediaObject('m3', 'failed'),
    ]);
    expect(failures).toBe(1);
    expect(status('c1')).toMatchObject({ status: 'ready', previewUrl: 'https://cdn/1.jpg' });
    expect(status('p1')).toMatchObject({ status: 'failed', error: PROCESSING_FAILED_MESSAGE });
    expect(status('c2')?.status).toBe('ready');
    expect(status('p2')?.status).toBe('uploading');
  });

  it('keeps waiting while the server still reports processing', () => {
    const { store, status } = setup();
    const tracker = createProcessingTracker();
    expect(tracker.apply(store, [mediaObject('m1', 'processing'), mediaObject('m3', 'awaiting_upload')], 0)).toBe(0);
    expect(status('c1')?.status).toBe('processing');
    expect(status('p1')?.status).toBe('processing');
  });

  it('gives up on a slot after the timeout, whether the server knows it or not', () => {
    const { store, status } = setup();
    const tracker = createProcessingTracker();
    const poll = [mediaObject('m1', 'processing')];
    expect(tracker.apply(store, poll, 1000)).toBe(0);
    expect(tracker.apply(store, poll, 1000 + PROCESSING_TIMEOUT_MS)).toBe(0);
    expect(tracker.apply(store, poll, 1001 + PROCESSING_TIMEOUT_MS)).toBe(2);
    expect(status('c1')).toMatchObject({ status: 'failed', error: PROCESSING_TIMEOUT_MESSAGE });
    expect(status('p1')).toMatchObject({ status: 'failed', error: PROCESSING_TIMEOUT_MESSAGE });
  });

  it('keeps a separate clock per slot', () => {
    const { store, status } = setup();
    const tracker = createProcessingTracker(10_000);
    tracker.apply(store, [], 0);
    tracker.apply(store, [mediaObject('m1', 'ready')], 5000);
    expect(status('c1')?.status).toBe('ready');
    expect(tracker.apply(store, [], 20_000)).toBe(1);
    expect(status('p1')?.status).toBe('failed');
  });
});
