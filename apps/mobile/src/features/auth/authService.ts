import { Platform } from 'react-native';
import type { AuthExchangeRequest } from '@rs/shared';
import { api, setTokenRefresher } from '../../api/client';
import { queryClient } from '../../api/queryClient';
import { ApiError } from '../../api/types';
import { useAuthStore } from '../../state/auth';
import { useDraftStore } from '../../state/draft';
import { clearRefreshToken, loadRefreshToken, saveRefreshToken } from './tokenStorage';

// The auth lifecycle: bootstrap at app start, sign in with a login code, refresh on 401, sign out.
// The access token lives in the auth store only; the refresh token is mirrored to secure storage.

// 4xx answers mean the server will never accept this refresh token (revoked, expired, shop needs re-login).
// 408 and 429 are transient. Network errors (status 0) and 5xx keep the session so the user can retry.
function isSessionRejected(error: unknown): boolean {
  return (
    error instanceof ApiError &&
    error.status >= 400 &&
    error.status < 500 &&
    error.status !== 408 &&
    error.status !== 429
  );
}

// Every change of the stored session is mirrored to secure storage here, whoever made it. Refresh tokens
// rotate, so the new one must be saved each time or the next launch would present a used-up token.
useAuthStore.subscribe((state, previous) => {
  const token = state.session?.refreshToken ?? null;
  if (token !== (previous.session?.refreshToken ?? null)) {
    void (token === null ? clearRefreshToken() : saveRefreshToken(token));
  }
  if (previous.session !== null && state.session === null) queryClient.clear();
});

let inFlightRefresh: Promise<boolean> | null = null;

async function runRefresh(): Promise<boolean> {
  const refreshToken = useAuthStore.getState().session?.refreshToken;
  if (refreshToken === undefined) return false;
  try {
    const session = await api.auth.refresh({ refreshToken });
    // The user may have logged out while the request was in flight.
    if (useAuthStore.getState().session?.refreshToken !== refreshToken) return false;
    useAuthStore.getState().setSession(session);
    return true;
  } catch (error) {
    if (isSessionRejected(error)) useAuthStore.getState().clearSession();
    return false;
  }
}

// One refresh at a time: concurrent 401s share the same promise, so the rotating refresh token is used once.
export function refreshSession(): Promise<boolean> {
  inFlightRefresh ??= runRefresh().finally(() => {
    inFlightRefresh = null;
  });
  return inFlightRefresh;
}

setTokenRefresher({ refresh: refreshSession });

let bootstrapStarted = false;

// Runs once at app start. Trades the stored refresh token for a fresh session, then opens the auth gate.
export async function bootstrapAuth(): Promise<void> {
  if (bootstrapStarted) return;
  bootstrapStarted = true;
  try {
    const refreshToken = await loadRefreshToken();
    if (refreshToken === null) return;
    try {
      useAuthStore.getState().setSession(await api.auth.refresh({ refreshToken }));
    } catch (error) {
      // A rejected token is dropped. After a network failure it is kept, and the user sees the login screen.
      if (isSessionRejected(error)) await clearRefreshToken();
    }
  } finally {
    useAuthStore.getState().markBootstrapped();
  }
}

function sessionPlatform(): AuthExchangeRequest['platform'] {
  return Platform.OS === 'ios' ? 'ios' : 'android';
}

function sessionDeviceName(): string {
  if (Platform.OS === 'android') return `${Platform.constants.Brand} ${Platform.constants.Model}`.trim();
  return Platform.OS === 'ios' && Platform.isPad ? 'iPad' : 'iPhone';
}

// POST /auth/exchange. Throws ApiError when the code is rejected or the server is unreachable.
export async function signInWithCode(code: string, codeVerifier: string): Promise<void> {
  const session = await api.auth.exchange({
    code,
    codeVerifier,
    platform: sessionPlatform(),
    deviceName: sessionDeviceName(),
  });
  useAuthStore.getState().setSession(session);
}

// POST /auth/logout, then clear. The local session is dropped even when the server call fails.
export async function signOut(): Promise<void> {
  const refreshToken = useAuthStore.getState().session?.refreshToken;
  if (refreshToken !== undefined) {
    try {
      await api.auth.logout({ refreshToken });
    } catch {
      // Offline or already revoked: nothing more to do on the server.
    }
  }
  useDraftStore.getState().reset();
  useAuthStore.getState().clearSession();
}
