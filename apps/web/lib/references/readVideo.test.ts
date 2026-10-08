import { afterEach, describe, expect, it, vi } from 'vitest';
import { readVideo, VideoReadError, type LoadedVideo, type VideoLoader } from './readVideo';

function video(patch: Partial<LoadedVideo> = {}): LoadedVideo & { disposed: number } {
  const loaded = {
    durationSec: 12.3456,
    width: 1080,
    height: 1920,
    capturePoster: async () => 'data:image/jpeg;base64,POSTER',
    disposed: 0,
    dispose: () => {
      loaded.disposed += 1;
    },
    ...patch,
  };
  return loaded;
}

const loaderFor = (loaded: LoadedVideo): VideoLoader => ({ load: async () => loaded });
const blob = new Blob(['x']);

afterEach(() => {
  vi.useRealTimers();
});

describe('readVideo', () => {
  it('reads the duration, size and poster, then releases the video', async () => {
    const loaded = video();
    const info = await readVideo(blob, { loader: loaderFor(loaded) });
    expect(info).toEqual({ durationSec: 12.35, width: 1080, height: 1920, poster: 'data:image/jpeg;base64,POSTER' });
    expect(loaded.disposed).toBe(1);
  });

  it('skips the poster on request', async () => {
    const loaded = video({ capturePoster: () => Promise.reject(new Error('must not run')) });
    expect((await readVideo(blob, { loader: loaderFor(loaded), withPoster: false })).poster).toBeNull();
  });

  it('still returns the duration when the poster cannot be captured', async () => {
    const loaded = video({ capturePoster: () => Promise.reject(new Error('seek failed')) });
    const info = await readVideo(blob, { loader: loaderFor(loaded) });
    expect(info.poster).toBeNull();
    expect(info.durationSec).toBe(12.35);
    expect(loaded.disposed).toBe(1);
  });

  it('rejects a video with an unusable duration and still releases it', async () => {
    for (const durationSec of [Number.POSITIVE_INFINITY, Number.NaN, 0]) {
      const loaded = video({ durationSec });
      await expect(readVideo(blob, { loader: loaderFor(loaded) })).rejects.toBeInstanceOf(VideoReadError);
      expect(loaded.disposed).toBe(1);
    }
  });

  it('turns a decode failure into a VideoReadError', async () => {
    const loader: VideoLoader = { load: () => Promise.reject(new Error('codec')) };
    await expect(readVideo(blob, { loader })).rejects.toBeInstanceOf(VideoReadError);
  });

  it('gives up after the timeout and releases a video that loads late', async () => {
    vi.useFakeTimers();
    const late = video();
    let finish: (loaded: LoadedVideo) => void = () => undefined;
    const loader: VideoLoader = {
      load: () =>
        new Promise<LoadedVideo>((resolve) => {
          finish = resolve;
        }),
    };
    const result = readVideo(blob, { loader, timeoutMs: 5000 });
    const assertion = expect(result).rejects.toThrow('Reading the video took too long.');
    await vi.advanceTimersByTimeAsync(5001);
    await assertion;
    finish(late);
    await vi.advanceTimersByTimeAsync(0);
    expect(late.disposed).toBe(1);
  });

  it('does not wait forever for the poster', async () => {
    vi.useFakeTimers();
    const loaded = video({ capturePoster: () => new Promise<string>(() => undefined) });
    const result = readVideo(blob, { loader: loaderFor(loaded) });
    await vi.advanceTimersByTimeAsync(5000);
    expect((await result).poster).toBeNull();
  });
});
