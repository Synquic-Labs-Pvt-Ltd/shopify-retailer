import { describe, expect, it } from 'vitest';
import { buildTitleSearch } from '../../src/modules/catalog/search';

describe('buildTitleSearch', () => {
  it('returns null when there is nothing to search', () => {
    expect(buildTitleSearch(undefined)).toBeNull();
    expect(buildTitleSearch('')).toBeNull();
    expect(buildTitleSearch('   ')).toBeNull();
    expect(buildTitleSearch('*,*')).toBeNull();
  });

  it('scopes every word to the title', () => {
    expect(buildTitleSearch('blue lamp')).toBe('title:*blue* title:*lamp*');
  });

  it('escapes the characters that carry meaning in search syntax', () => {
    expect(buildTitleSearch('status:draft')).toBe('title:*status\\:draft*');
    expect(buildTitleSearch('a(b)')).toBe('title:*a\\(b\\)*');
    expect(buildTitleSearch(`it's "x"`)).toBe('title:*it\\\'s* title:*\\"x\\"*');
    expect(buildTitleSearch('back\\slash')).toBe('title:*back\\\\slash*');
  });

  it('cannot start another filter, operator or negation', () => {
    expect(buildTitleSearch('OR')).toBe('title:*OR*');
    expect(buildTitleSearch('-tag:sale')).toBe('title:*-tag\\:sale*');
    expect(buildTitleSearch('vendor:x OR tag:y')).toBe('title:*vendor\\:x* title:*OR* title:*tag\\:y*');
  });

  it('removes wildcards, commas and control characters from words', () => {
    expect(buildTitleSearch('a*b,c\u0000d')).toBe('title:*abcd*');
  });

  it('keeps non-latin words', () => {
    expect(buildTitleSearch('ランプ café')).toBe('title:*ランプ* title:*café*');
  });

  it('limits the number of terms', () => {
    const terms = buildTitleSearch('a b c d e f g h i j');
    expect(terms?.split(' ')).toHaveLength(8);
  });
});
