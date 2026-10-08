// RFC 4122 version 4 id. crypto.randomUUID needs a secure context, so a plain http dev tab falls back to
// Math.random; these ids are idempotency keys and slot ids, not secrets.
export function newId(): string {
  const webCrypto: Crypto | undefined = globalThis.crypto;
  if (webCrypto !== undefined && typeof webCrypto.randomUUID === 'function') return webCrypto.randomUUID();
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (char) => {
    const random = Math.floor(Math.random() * 16);
    return (char === 'x' ? random : (random & 0x3) | 0x8).toString(16);
  });
}
