import { ApiError, referencesRequiredDetailsSchema } from '@rs/shared';
import { retryAfterSecOf } from './retry';

const FALLBACK_MESSAGE = 'Something went wrong. Try again.';

// "Wait 12 seconds", "Wait 2 minutes"; a moment when the server did not say.
function waitText(retryAfterSec: number | null): string {
  if (retryAfterSec === null) return 'Wait a moment';
  const seconds = Math.ceil(retryAfterSec);
  if (seconds < 60) return `Wait ${seconds} ${seconds === 1 ? 'second' : 'seconds'}`;
  const minutes = Math.ceil(seconds / 60);
  return `Wait ${minutes} ${minutes === 1 ? 'minute' : 'minutes'}`;
}

function isOffline(): boolean {
  return typeof navigator !== 'undefined' && navigator.onLine === false;
}

// A user-facing sentence for any error that reaches a page.
export function errorMessage(error: unknown, fallback: string = FALLBACK_MESSAGE): string {
  if (!(error instanceof ApiError)) return fallback;
  switch (error.code) {
    case 'network_error':
      return isOffline()
        ? 'You are offline. Reconnect to the internet and try again.'
        : 'Cannot reach the server. Check your connection and try again.';
    case 'timeout':
      return 'The server took too long to answer. Try again.';
    case 'service_unavailable':
      return 'The service is busy or temporarily down. Try again in a moment.';
    case 'too_many_requests':
      return `Too many requests. ${waitText(retryAfterSecOf(error.details))} and try again.`;
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
