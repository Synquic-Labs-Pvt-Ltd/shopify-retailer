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
