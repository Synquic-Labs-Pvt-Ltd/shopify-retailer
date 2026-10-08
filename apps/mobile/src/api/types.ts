export { ApiError } from '@rs/shared';
export type { Api, ApiErrorCode } from '@rs/shared';

// One refresh-and-retry on 401. The auth feature supplies the real implementation with setTokenRefresher.
export interface TokenRefresher {
  // Resolves true when a new access token is now in the auth store.
  refresh(): Promise<boolean>;
}
