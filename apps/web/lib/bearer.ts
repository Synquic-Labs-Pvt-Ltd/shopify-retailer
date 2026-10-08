// True for an `Authorization: Bearer <token>` header with a single non-empty token. The value itself is checked
// elsewhere (by the backend); this only filters out requests that carry no credentials at all.
export function hasBearerToken(authorization: string | null): boolean {
  return authorization !== null && /^Bearer\s+\S+$/i.test(authorization.trim());
}
