const BLOCK_TAGS = /<\/?(?:p|div|br|li|ul|ol|h[1-6]|tr|table|blockquote|section|article|hr)\b(?:"[^"]*"|'[^']*'|[^'">])*>/gi;
const ANY_TAG = /<\/?[a-zA-Z](?:"[^"]*"|'[^']*'|[^'">])*>/g;
const COMMENT = /<!--[\s\S]*?-->/g;
const SCRIPT_OR_STYLE = /<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/gi;

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  ndash: '–',
  mdash: '—',
  hellip: '…',
  lsquo: '‘',
  rsquo: '’',
  ldquo: '“',
  rdquo: '”',
  copy: '©',
  reg: '®',
  trade: '™',
  deg: '°',
};

function codePointToString(codePoint: number, original: string): string {
  const valid =
    Number.isInteger(codePoint) && codePoint > 0 && codePoint <= 0x10ffff && !(codePoint >= 0xd800 && codePoint <= 0xdfff);
  return valid ? String.fromCodePoint(codePoint) : original;
}

// One pass over the text, so "&amp;lt;" becomes "&lt;" and is not decoded twice.
function decodeEntities(text: string): string {
  return text.replace(
    /&(?:#(\d{1,7})|#[xX]([0-9a-fA-F]{1,6})|([a-zA-Z][a-zA-Z0-9]{1,10}));/g,
    (match, dec?: string, hex?: string, name?: string) => {
      if (dec !== undefined) return codePointToString(Number.parseInt(dec, 10), match);
      if (hex !== undefined) return codePointToString(Number.parseInt(hex, 16), match);
      return (name === undefined ? undefined : NAMED_ENTITIES[name.toLowerCase()]) ?? match;
    },
  );
}

function truncate(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text;
  const cut = text.slice(0, maxLength);
  const last = cut.charCodeAt(cut.length - 1);
  // Do not leave half of a surrogate pair at the end.
  const safe = last >= 0xd800 && last <= 0xdbff ? cut.slice(0, -1) : cut;
  return safe.trimEnd();
}

// Product descriptionHtml to plain text for the planner prompt (SPEC 8.5): block tags become line
// breaks, every other tag is dropped, entities are decoded, whitespace is collapsed.
export function htmlToPlainText(html: string, maxLength: number): string {
  const withBreaks = html
    .replace(SCRIPT_OR_STYLE, ' ')
    .replace(COMMENT, ' ')
    .replace(BLOCK_TAGS, '\n')
    .replace(ANY_TAG, '');
  const text = decodeEntities(withBreaks)
    .split('\n')
    .map((line) => line.replace(/[ \t\f\v\r ]+/g, ' ').trim())
    .filter((line) => line.length > 0)
    .join('\n');
  return truncate(text, maxLength);
}
