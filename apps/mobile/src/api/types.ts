import type {
  AuthExchangeRequest,
  AuthLogoutRequest,
  AuthRefreshRequest,
  AuthSessionResponse,
  BatchDetail,
  BatchListResponse,
  BatchSummary,
  CreateBatchInput,
  ErrorCode,
  MeResponse,
  MediaListResponse,
  MediaObject,
  PaginationParams,
  ProductDetail,
  ProductListParams,
  ProductListResponse,
  UploadsRequest,
  UploadsResponse,
} from '@rs/shared';

export type ApiErrorCode = ErrorCode | 'network_error' | 'invalid_response';

export class ApiError extends Error {
  readonly status: number;
  readonly code: ApiErrorCode;
  readonly details: unknown;

  constructor(status: number, code: ApiErrorCode, message: string, details?: unknown) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

// One typed method per endpoint of SPEC section 15 that the app calls. Implemented by the HTTP client
// and by the in-memory mock (EXPO_PUBLIC_API_MOCK=true).
export interface Api {
  auth: {
    exchange(body: AuthExchangeRequest): Promise<AuthSessionResponse>;
    refresh(body: AuthRefreshRequest): Promise<AuthSessionResponse>;
    logout(body: AuthLogoutRequest): Promise<void>;
  };
  me(): Promise<MeResponse>;
  products: {
    list(params?: ProductListParams): Promise<ProductListResponse>;
    get(gid: string): Promise<ProductDetail>;
  };
  media: {
    createUploads(body: UploadsRequest): Promise<UploadsResponse>;
    complete(id: string): Promise<MediaObject>;
    list(ids: string[]): Promise<MediaListResponse>;
    remove(id: string): Promise<void>;
  };
  batches: {
    create(body: CreateBatchInput): Promise<BatchSummary>;
    list(params?: PaginationParams): Promise<BatchListResponse>;
    get(id: string): Promise<BatchDetail>;
    cancel(id: string): Promise<BatchSummary>;
    retryFailed(id: string): Promise<BatchSummary>;
  };
}

// One refresh-and-retry on 401. The auth feature supplies the real implementation with setTokenRefresher.
export interface TokenRefresher {
  // Resolves true when a new access token is now in the auth store.
  refresh(): Promise<boolean>;
}
