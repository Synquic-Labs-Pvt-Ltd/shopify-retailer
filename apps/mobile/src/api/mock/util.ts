// Shared helpers of the in-memory mock API (EXPO_PUBLIC_API_MOCK=true). Image URLs are public placeholders
// (picsum.photos, a public sample mp4); the mock never talks to the backend.

export const LATENCY_MS = 120;
export const IMAGES_PER_PRODUCT = 2;
export const VIDEOS_PER_PRODUCT = 1;
export const SAMPLE_VIDEO_URL = 'https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/ForBiggerBlazes.mp4';

export function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function objectId(n: number): string {
  return n.toString(16).padStart(24, '0');
}

export function productGid(index: number): string {
  return `gid://shopify/Product/${8000000000 + index}`;
}

export function picture(seed: string, width: number, height: number): string {
  return `https://picsum.photos/seed/${seed}/${width}/${height}`;
}

export function slugify(title: string): string {
  return title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}
