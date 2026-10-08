import type { LoadedVideo, VideoLoader } from './readVideo';

// The browser implementation of VideoLoader: a detached <video preload="metadata"> on an object URL.
// Only touches the DOM inside load(), so importing it on the server is safe.

const POSTER_QUALITY = 0.7;

function seekTo(video: HTMLVideoElement, seconds: number): Promise<void> {
  return new Promise((resolve, reject) => {
    video.addEventListener('seeked', () => resolve(), { once: true });
    video.addEventListener('error', () => reject(new Error('The video could not be decoded.')), { once: true });
    video.currentTime = seconds;
  });
}

async function capture(video: HTMLVideoElement, maxEdge: number): Promise<string> {
  await seekTo(video, Math.min(1, video.duration / 2));
  const ratio = Math.min(1, maxEdge / Math.max(video.videoWidth, video.videoHeight));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(video.videoWidth * ratio));
  canvas.height = Math.max(1, Math.round(video.videoHeight * ratio));
  const context = canvas.getContext('2d');
  if (context === null) throw new Error('Canvas is not available.');
  context.drawImage(video, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL('image/jpeg', POSTER_QUALITY);
}

export const browserVideoLoader: VideoLoader = {
  load: (file) =>
    new Promise<LoadedVideo>((resolve, reject) => {
      const video = document.createElement('video');
      video.preload = 'metadata';
      video.muted = true;
      video.playsInline = true;
      const url = URL.createObjectURL(file);
      const dispose = (): void => {
        video.removeAttribute('src');
        video.load();
        URL.revokeObjectURL(url);
      };
      video.onloadedmetadata = () =>
        resolve({
          durationSec: video.duration,
          width: video.videoWidth,
          height: video.videoHeight,
          capturePoster: (maxEdge) => capture(video, maxEdge),
          dispose,
        });
      video.onerror = () => {
        dispose();
        reject(new Error('The video could not be decoded.'));
      };
      video.src = url;
    }),
};
