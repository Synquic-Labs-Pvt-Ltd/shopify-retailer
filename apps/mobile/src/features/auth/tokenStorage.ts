import * as SecureStore from 'expo-secure-store';

// The refresh token is the only credential kept on the device, in the Keychain or Android Keystore.
// It never leaves this device (no backup migration on iOS). The access token lives in memory only.
const KEY = 'rs.refreshToken';
const OPTIONS: SecureStore.SecureStoreOptions = {
  keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY,
};

// Writes are serialized so a rotated token can never be overwritten by an older one that finished later.
let queue: Promise<unknown> = Promise.resolve();

function enqueue<T>(task: () => Promise<T>): Promise<T> {
  const result = queue.then(task, task);
  queue = result.catch(() => undefined);
  return result;
}

// A keystore failure (corrupted entry, restored backup) is treated as "no token": the user logs in again.
export function loadRefreshToken(): Promise<string | null> {
  return enqueue(() => SecureStore.getItemAsync(KEY, OPTIONS)).catch(() => null);
}

export function saveRefreshToken(token: string): Promise<void> {
  return enqueue(() => SecureStore.setItemAsync(KEY, token, OPTIONS)).catch(() => undefined);
}

export function clearRefreshToken(): Promise<void> {
  return enqueue(() => SecureStore.deleteItemAsync(KEY, OPTIONS)).catch(() => undefined);
}
