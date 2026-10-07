import { useCallback, useState } from 'react';
import { isValidShopDomain, normalizeShopDomain } from '@rs/shared';
import { API_MOCK } from '../../api/client';
import { ApiError } from '../../api/types';
import { haptics, useToast } from '../../design';
import { signInWithCode } from './authService';
import { runShopifyLogin } from './shopifyLogin';

// Drops a pasted scheme or path, so "https://my-store.myshopify.com/admin" still yields the domain.
function cleanShopInput(input: string): string {
  return input.trim().replace(/^[a-z][a-z0-9+.-]*:\/\//i, '').split(/[/?#]/)[0] ?? '';
}

// Shop domain entry and the login flow. Cancelled is silent, an invalid domain is a field error,
// everything else (server, network, bad redirect) is a toast.
export function useLogin() {
  const toast = useToast();
  // Mock mode starts with a valid domain so the flow works without typing.
  const [domain, setDomainState] = useState(API_MOCK ? 'mock-store' : '');
  const [fieldError, setFieldError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const setDomain = useCallback((value: string) => {
    setDomainState(value);
    setFieldError(null);
  }, []);

  const submit = useCallback(async () => {
    if (loading) return;
    const cleaned = cleanShopInput(domain);
    if (cleaned === '') {
      setFieldError('Enter your store domain.');
      return;
    }
    const shop = normalizeShopDomain(cleaned);
    if (!isValidShopDomain(shop)) {
      setFieldError('Use letters, numbers and hyphens, like my-store.');
      return;
    }

    setFieldError(null);
    setLoading(true);
    try {
      const result = await runShopifyLogin(shop);
      if (result.kind === 'cancelled') return;
      if (result.kind === 'failed') {
        toast.error(result.message);
        return;
      }
      await signInWithCode(result.code, result.codeVerifier);
      // The session is set: the auth gate switches to the main stack.
      haptics.success();
    } catch (error) {
      toast.error(error instanceof ApiError ? error.message : 'Could not log in. Please try again.');
    } finally {
      setLoading(false);
    }
  }, [domain, loading, toast]);

  return { domain, setDomain, fieldError, loading, submit };
}
