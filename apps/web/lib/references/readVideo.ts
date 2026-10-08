// Reads what the upload needs from a video without sending it anywhere: the duration (the backend wants
// durationSec) and, best effort, a small poster frame for the slot. The <video> element sits behind an adapter.
export const VIDEO_READ_TIMEOUT_MS = 10_000;
export const POSTER_TIMEOUT_MS = 4_000;
export const POSTER_EDGE = 160;

export interface LoadedVideo {
  durationSec: number;
  width: number;
  height: number;
  // A JPEG data URL of an early frame, scaled to maxEdge.
  capturePoster(maxEdge: number): Promise<string>;
  // Releases the object URL and the element.
  dispose(): void;
}

export interface VideoLoader {
  // Resolves once the metadata is available; rejects when the browser cannot decode the file.
  load(file: Blob): Promise<LoadedVideo>;
}

export interface VideoInfo {
  durationSec: number;
  width: number;
  height: number;
  poster: string | null;
}

export class VideoReadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'VideoReadError';
  }
}

export interface ReadVideoOptions {
  loader: VideoLoader;
  timeoutMs?: number;
  posterEdge?: number;
  withPoster?: boolean;
}

function withTimeout<T>(promise: Promise<T>, ms: number, onTimeout: () => void): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      onTimeout();
      reject(new VideoReadError('Reading the video took too long.'));
    }, ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

export async function readVideo(file: Blob, options: ReadVideoOptions): Promise<VideoInfo> {
  const { loader, timeoutMs = VIDEO_READ_TIMEOUT_MS, posterEdge = POSTER_EDGE, withPoster = true } = options;
  let timedOut = false;
  let video: LoadedVideo;
  try {
    video = await withTimeout(
      loader.load(file).then((loaded) => {
        // A load that finishes after the timeout is nobody's: release it here.
        if (timedOut) loaded.dispose();
        return loaded;
      }),
      timeoutMs,
      () => {
        timedOut = true;
      },
    );
  } catch (error) {
    throw error instanceof VideoReadError ? error : new VideoReadError('The video could not be read.');
  }

  try {
    if (!Number.isFinite(video.durationSec) || video.durationSec <= 0) {
      throw new VideoReadError('The length of this video could not be read.');
    }
    const poster = withPoster
      ? await withTimeout(video.capturePoster(posterEdge), POSTER_TIMEOUT_MS, () => undefined).catch(() => null)
      : null;
    return {
      durationSec: Math.round(video.durationSec * 100) / 100,
      width: video.width,
      height: video.height,
      poster,
    };
  } finally {
    video.dispose();
  }
}
