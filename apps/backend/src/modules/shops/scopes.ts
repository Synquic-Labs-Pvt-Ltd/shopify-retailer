// Shopify returns scopes as a comma-separated string.
export function parseScopes(scope: string | undefined): string[] {
  if (scope === undefined) return [];
  return scope
    .split(',')
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

// A write_* grant includes its matching read_* scope, so Shopify may return only the write scope.
export function scopesSatisfy(granted: readonly string[], required: readonly string[]): boolean {
  return required.every(
    (scope) => granted.includes(scope) || (scope.startsWith('read_') && granted.includes(`write_${scope.slice(5)}`)),
  );
}
