// A File cannot be persisted, so the bytes of a reference that is being uploaded live here, in memory only.
// After a reload the registry is empty: those slots can be removed but not retried.
export interface FileRegistry {
  get(clientId: string): File | undefined;
  set(clientId: string, file: File): void;
  delete(clientId: string): void;
  has(clientId: string): boolean;
  clear(): void;
}

export function createFileRegistry(): FileRegistry {
  const files = new Map<string, File>();
  return {
    get: (clientId) => files.get(clientId),
    set: (clientId, file) => void files.set(clientId, file),
    delete: (clientId) => void files.delete(clientId),
    has: (clientId) => files.has(clientId),
    clear: () => files.clear(),
  };
}

export const fileRegistry = createFileRegistry();

export const getFile = (clientId: string): File | undefined => fileRegistry.get(clientId);
export const setFile = (clientId: string, file: File): void => fileRegistry.set(clientId, file);
export const deleteFile = (clientId: string): void => fileRegistry.delete(clientId);
export const hasFile = (clientId: string): boolean => fileRegistry.has(clientId);
