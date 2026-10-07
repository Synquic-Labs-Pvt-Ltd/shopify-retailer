// State of the in-memory Shopify used by the e2e suite: shops with products and Files, the staged upload
// targets, the CDN and a log of every request the backend made.

export interface StubProduct {
  id: string;
  title: string;
  handle: string;
  vendor: string;
  productType: string;
  status: 'ACTIVE' | 'DRAFT' | 'ARCHIVED' | 'UNLISTED';
  descriptionHtml: string;
  tags: string[];
  options: { name: string; values: string[] }[];
  imageUrls: string[];
}

export interface StagedTarget {
  key: string;
  url: string;
  resourceUrl: string;
  parameters: { name: string; value: string }[];
  resource: 'IMAGE' | 'VIDEO';
  filename: string;
  mimeType: string;
  fileSize: number;
  received: { bytes: Uint8Array; type: string; filename: string } | null;
}

export interface StubFile {
  gid: string;
  mediaType: 'image' | 'video';
  filename: string;
  alt: string;
  resourceUrl: string;
  cdnUrl: string;
  bytes: Uint8Array | null;
  statusQueries: number;
  failure: { code: string; message: string } | null;
}

export interface ShopInfo {
  id: string;
  name: string;
  email: string;
  currencyCode: string;
  ianaTimezone: string;
}

export interface StubShop {
  domain: string;
  number: number;
  info: ShopInfo;
  products: StubProduct[];
  offlineTokens: Set<string>;
  onlineTokens: Set<string>;
  refreshToken: string | null;
  stagedByKey: Map<string, StagedTarget>;
  files: Map<string, StubFile>;
}

export interface CdnObject {
  bytes: Uint8Array;
  type: string;
}

export interface UserError {
  field: string[] | null;
  message: string;
  code?: string;
}

export interface FileCreateRecord {
  originalSource: string;
  contentType: string;
  filename: string;
  alt: string;
}

export type StubCall =
  | { kind: 'token'; shop: string; grant: 'authorization_code' | 'refresh_token'; expiring: boolean; status: number }
  | { kind: 'graphql'; shop: string; operation: string; variables: Record<string, unknown>; token: string | undefined }
  | { kind: 'staged_upload'; shop: string; key: string; filename: string; size: number; type: string; status: number }
  | { kind: 'cdn'; url: string; status: number };

export interface StubKnobs {
  failShopQuery: boolean;
  // Shops whose refresh_token grant answers 401 (expired or revoked refresh token).
  rejectRefresh: Set<string>;
  // The next `remaining` GraphQL requests of this operation answer THROTTLED.
  throttle: { operation: string; remaining: number } | null;
  // Return userErrors to make fileCreate refuse a file.
  fileCreateRejection: ((file: FileCreateRecord) => UserError[] | undefined) | null;
  // Status queries answered PROCESSING before a file turns READY.
  processingQueries: (file: StubFile) => number;
  // CDN urls containing one of these substrings answer 404.
  cdnNotFound: string[];
}

export interface StubState {
  shops: Map<string, StubShop>;
  cdn: Map<string, CdnObject>;
  calls: StubCall[];
  unexpected: string[];
  knobs: StubKnobs;
  counter: number;
}

export function createStubState(): StubState {
  return {
    shops: new Map(),
    cdn: new Map(),
    calls: [],
    unexpected: [],
    counter: 0,
    knobs: {
      failShopQuery: false,
      rejectRefresh: new Set(),
      throttle: null,
      fileCreateRejection: null,
      // References and videos take a second status query, still images are ready at once.
      processingQueries: (file) => (file.filename.startsWith('rs-ref-') || file.mediaType === 'video' ? 1 : 0),
      cdnNotFound: [],
    },
  };
}
