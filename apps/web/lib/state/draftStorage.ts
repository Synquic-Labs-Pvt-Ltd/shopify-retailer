// The slice of Storage the draft needs. Synchronous on purpose: persist then hydrates in one step.
export interface SyncStorage {
  getItem(name: string): string | null;
  setItem(name: string, value: string): void;
  removeItem(name: string): void;
}

export function createMemoryStorage(): SyncStorage {
  const items = new Map<string, string>();
  return {
    getItem: (name) => items.get(name) ?? null,
    setItem: (name, value) => void items.set(name, value),
    removeItem: (name) => void items.delete(name),
  };
}

const noopStorage: SyncStorage = {
  getItem: () => null,
  setItem: () => undefined,
  removeItem: () => undefined,
};

// Storage errors (quota, a blocked iframe, private mode) must never break a state update, and a value that is
// not JSON must read as empty: persist never finishes hydrating when the read throws.
export function guardStorage(inner: SyncStorage): SyncStorage {
  return {
    getItem: (name) => {
      try {
        const raw = inner.getItem(name);
        if (raw !== null) JSON.parse(raw);
        return raw;
      } catch {
        return null;
      }
    },
    setItem: (name, value) => {
      try {
        inner.setItem(name, value);
      } catch {
        // Quota or blocked storage: the draft then lives in memory only.
      }
    },
    removeItem: (name) => {
      try {
        inner.removeItem(name);
      } catch {
        // Nothing to clean up.
      }
    },
  };
}

// localStorage in the browser, nothing on the server, and memory when the browser denies storage to the
// embedded iframe (third-party storage rules). Always returns a storage so persist can finish hydrating.
export function browserDraftStorage(): SyncStorage {
  if (typeof window === 'undefined') return noopStorage;
  try {
    return guardStorage(window.localStorage);
  } catch {
    return createMemoryStorage();
  }
}
