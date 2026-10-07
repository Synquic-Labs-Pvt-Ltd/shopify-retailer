export function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

export function requestUrl(input: string | URL | Request): URL {
  if (typeof input === 'string') return new URL(input);
  return input instanceof URL ? input : new URL(input.url);
}

// Every GraphQL answer carries the cost extension, like the real Admin API.
export function graphqlData(data: unknown, requestedQueryCost = 12): Response {
  return jsonResponse(200, {
    data,
    extensions: {
      cost: {
        requestedQueryCost,
        actualQueryCost: requestedQueryCost - 2,
        throttleStatus: { maximumAvailable: 2000, currentlyAvailable: 1990, restoreRate: 100 },
      },
    },
  });
}

export function graphqlThrottled(): Response {
  return jsonResponse(200, {
    errors: [{ message: 'Throttled', extensions: { code: 'THROTTLED' } }],
    extensions: {
      cost: {
        requestedQueryCost: 50,
        actualQueryCost: null,
        throttleStatus: { maximumAvailable: 1000, currentlyAvailable: 10, restoreRate: 100 },
      },
    },
  });
}

export function graphqlError(message: string): Response {
  return jsonResponse(200, { errors: [{ message }] });
}

// Reads width and height from the first SOF marker of a JPEG, like Shopify does for MediaImage.
export function jpegSize(bytes: Uint8Array): { width: number; height: number } | null {
  let offset = 2;
  while (offset + 9 < bytes.length) {
    if (bytes[offset] !== 0xff) {
      offset += 1;
      continue;
    }
    const marker = bytes[offset + 1] ?? 0;
    if (marker >= 0xc0 && marker <= 0xc3) {
      const height = ((bytes[offset + 5] ?? 0) << 8) | (bytes[offset + 6] ?? 0);
      const width = ((bytes[offset + 7] ?? 0) << 8) | (bytes[offset + 8] ?? 0);
      return { width, height };
    }
    offset += 2 + (((bytes[offset + 2] ?? 0) << 8) | (bytes[offset + 3] ?? 0));
  }
  return null;
}

const MIME_BY_EXTENSION: Record<string, string> = {
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
  mp4: 'video/mp4',
  mov: 'video/quicktime',
};

export function mimeForPath(path: string): string {
  const extension = /\.([a-z0-9]+)$/i.exec(path)?.[1]?.toLowerCase();
  return (extension === undefined ? undefined : MIME_BY_EXTENSION[extension]) ?? 'application/octet-stream';
}
