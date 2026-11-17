import { describe, expect, it } from 'vitest';
import { buildProductSearch, buildTitleSearch } from '../../src/modules/catalog/search';

describe('buildTitleSearch', () => {
  it('returns null when there is nothing to search', () => {
    expect(buildTitleSearch(undefined)).toBeNull();
    expect(buildTitleSearch('')).toBeNull();
    expect(buildTitleSearch('   ')).toBeNull();
    expect(buildTitleSearch('*,*')).toBeNull();
  });

  it('scopes every word to the title or the variant SKU', () => {
    expect(buildTitleSearch('blue lamp')).toBe('(title:*blue* OR sku:blue*) (title:*lamp* OR sku:lamp*)');
  });

  it('escapes the characters that carry meaning in search syntax', () => {
    expect(buildTitleSearch('status:draft')).toBe('(title:*status\\:draft* OR sku:status\\:draft*)');
    expect(buildTitleSearch('a(b)')).toBe('(title:*a\\(b\\)* OR sku:a\\(b\\)*)');
    expect(buildTitleSearch(`it's "x"`)).toBe(`(title:*it\\'s* OR sku:it\\'s*) (title:*\\"x\\"* OR sku:\\"x\\"*)`);
    expect(buildTitleSearch('back\\slash')).toBe('(title:*back\\\\slash* OR sku:back\\\\slash*)');
  });

  it('cannot start another filter, operator or negation', () => {
    expect(buildTitleSearch('OR')).toBe('(title:*OR* OR sku:OR*)');
    expect(buildTitleSearch('-tag:sale')).toBe('(title:*-tag\\:sale* OR sku:-tag\\:sale*)');
    expect(buildTitleSearch('vendor:x OR tag:y')).toBe(
      '(title:*vendor\\:x* OR sku:vendor\\:x*) (title:*OR* OR sku:OR*) (title:*tag\\:y* OR sku:tag\\:y*)',
    );
  });

  it('removes wildcards, commas and control characters from words', () => {
    expect(buildTitleSearch('a*b,c d')).toBe('(title:*abcd* OR sku:abcd*)');
  });

  it('keeps non-latin words', () => {
    expect(buildTitleSearch('ランプ café')).toBe('(title:*ランプ* OR sku:ランプ*) (title:*café* OR sku:café*)');
  });

  it('limits the number of terms', () => {
    const terms = buildTitleSearch('a b c d e f g h i j');
    expect(terms?.split(' ')).toHaveLength(8 * 4);
  });
});

describe('buildProductSearch', () => {
  it('is null without a status tab or searchable text', () => {
    expect(buildProductSearch(undefined, undefined)).toBeNull();
    expect(buildProductSearch('  ', undefined)).toBeNull();
  });

  it('adds the status filter in front of the title terms', () => {
    expect(buildProductSearch(undefined, 'active')).toBe('status:active');
    expect(buildProductSearch('blue lamp', 'draft')).toBe(
      'status:draft (title:*blue* OR sku:blue*) (title:*lamp* OR sku:lamp*)',
    );
  });

  it('keeps typed text from becoming a filter of its own', () => {
    expect(buildProductSearch('status:draft', 'active')).toBe(
      'status:active (title:*status\\:draft* OR sku:status\\:draft*)',
    );
  });
});
