import type {
  ActivatePromptRequest,
  AttachMediaRequest,
  AttachMediaResponse,
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
  PromptDetail,
  PromptListResponse,
  PromptName,
  PromptVersionText,
  SavePromptRequest,
  ProductDetail,
  ProductListParams,
  ProductListResponse,
  UploadsRequest,
  UploadsResponse,
} from './index';

export type ApiErrorCode = ErrorCode | 'network_error' | 'timeout' | 'service_unavailable' | 'invalid_response';

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

// One typed method per endpoint of SPEC section 15 that the clients call. Implemented by each app's HTTP client
// and by the in-memory mock in @rs/mock-api.
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
    // Adds the ready outputs to the Shopify products they were made for.
    attachMedia(id: string, body?: AttachMediaRequest): Promise<AttachMediaResponse>;
  };
}

// Per-store prompt editing (SPEC 12.6). The embedded web app implements it; the mobile app does not use it, so it
// is not part of Api.
export interface PromptsApi {
  list(): Promise<PromptListResponse>;
  get(name: PromptName): Promise<PromptDetail>;
  getVersion(name: PromptName, version: number): Promise<PromptVersionText>;
  // Saves the text as the next version and makes it the active one.
  save(name: PromptName, body: SavePromptRequest): Promise<PromptDetail>;
  // Makes a saved version active again. Version 0 is the global default (a reset).
  activate(name: PromptName, body: ActivatePromptRequest): Promise<PromptDetail>;
}
