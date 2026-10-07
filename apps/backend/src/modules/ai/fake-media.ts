import { fromBase64 } from './json';

// Smallest useful media for the fake provider.

// A 16x16 flat gray baseline JPEG (SOI to EOI), decodable by any viewer.
const JPEG_BASE64 =
  '/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAMCAgMCAgMDAwMEAwMEBQgFBQQEBQoHBwYIDAoMDAsKCwsNDhIQDQ4RDgsLEBYQERMUFRUVDA8XGBYUGBIUFRT/2wBDAQMEBAUEBQkFBQkUDQsNFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBT/wAARCAAQABADASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwD7AoooqAP/2Q==';

export const FAKE_JPEG: Uint8Array = fromBase64(JPEG_BASE64);

function ascii(text: string): number[] {
  return [...text].map((char) => char.charCodeAt(0));
}

function box(type: string, payload: number[] = []): number[] {
  const size = 8 + payload.length;
  return [(size >>> 24) & 0xff, (size >>> 16) & 0xff, (size >>> 8) & 0xff, size & 0xff, ...ascii(type), ...payload];
}

// A structurally plausible MP4 stub: ftyp, free and mdat boxes. It is NOT decodable video; swap in a real
// clip if a downstream consumer needs playable output.
export const FAKE_MP4: Uint8Array = new Uint8Array([
  ...box('ftyp', [...ascii('isom'), 0, 0, 2, 0, ...ascii('isom'), ...ascii('mp41')]),
  ...box('free'),
  ...box('mdat', ascii('retailer-studio-fake-video')),
]);
