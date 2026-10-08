import { ApiError, referencesRequiredDetailsSchema } from '@rs/shared';

const FALLBACK_MESSAGE = 'Something went wrong. Try again.';

// A user-facing sentence for any error that reaches a page.
export function errorMessage(error: unknown, fallback: string = FALLBACK_MESSAGE): string {
  if (!(error instanceof ApiError)) return fallback;
  switch (error.code) {
    case 'network_error':
      return 'Cannot reach the server. Check your connection and try again.';
    case 'unauthorized':
      return 'Your session could not be verified. Reopen the app from the Shopify admin.';
    case 'shop_reauth_required':
      return 'Your store needs to be reconnected. Reopen the app from the Shopify admin.';
    case 'references_required':
      return 'Some products still need a reference.';
    case 'shop_limit':
    case 'in_use':
    case 'not_found':
    case 'validation_failed':
    case 'too_many_requests':
      return error.message;
    case 'forbidden':
    case 'not_implemented':
    case 'internal':
    case 'invalid_response':
      return fallback;
  }
}

// The product GIDs a 422 references_required response names (SPEC 9), or null for any other error.
export function unresolvedProductGids(error: unknown): string[] | null {
  if (!(error instanceof ApiError) || error.code !== 'references_required') return null;
  const parsed = referencesRequiredDetailsSchema.safeParse(error.details);
  return parsed.success ? parsed.data.productGids : [];
}
