import type { ProductListQuery } from '@rs/shared';

const MAX_TERMS = 8;
// Characters that carry meaning in Shopify search syntax (https://shopify.dev/docs/api/usage/search-syntax).
const SYNTAX_CHARACTERS = /[\\"'():]/g;

function sanitizeTerm(term: string): string {
  return term
    .replace(/\p{C}/gu, '')
    .replace(/[*,]/g, '')
    .replace(SYNTAX_CHARACTERS, '\\$&');
}

// Turns what the merchant typed into a Shopify products query scoped to the title. Every word becomes
// its own title:*word* term, so a word can never be read as a filter (status:, tag:), an operator
// (OR, NOT, a leading minus) or a comparator. Returns null when nothing searchable is left.
export function buildTitleSearch(input: string | undefined): string | null {
  if (input === undefined) return null;
  const terms = input
    .split(/\s+/)
    .map(sanitizeTerm)
    .filter((term) => term.length > 0)
    .slice(0, MAX_TERMS);
  return terms.length === 0 ? null : terms.map((term) => `title:*${term}*`).join(' ');
}

// The status tabs map to Shopify's status filter. It is added by this module, never taken from the typed text.
const STATUS_FILTERS: Record<NonNullable<ProductListQuery['status']>, string> = {
  active: 'status:active',
  draft: 'status:draft',
};

// The full products query: the optional status filter and the title terms, ANDed. Null when there is neither.
export function buildProductSearch(input: string | undefined, status: ProductListQuery['status']): string | null {
  const parts = [status === undefined ? null : STATUS_FILTERS[status], buildTitleSearch(input)].filter((part): part is string => part !== null);
  return parts.length === 0 ? null : parts.join(' ');
}
