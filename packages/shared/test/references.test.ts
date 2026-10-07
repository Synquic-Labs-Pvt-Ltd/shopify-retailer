import { describe, expect, it } from 'vitest';
import { resolveReferences } from '../src';

describe('resolveReferences (SPEC 9 table)', () => {
  it('own and common -> own_plus_common, own first', () => {
    expect(resolveReferences(['o1', 'o2'], ['c1'])).toEqual({ mode: 'own_plus_common', effective: ['o1', 'o2', 'c1'] });
  });

  it('own only', () => {
    expect(resolveReferences(['o1'], [])).toEqual({ mode: 'own_only', effective: ['o1'] });
  });

  it('common only', () => {
    expect(resolveReferences([], ['c1', 'c2'])).toEqual({ mode: 'common_only', effective: ['c1', 'c2'] });
  });

  it('neither is unresolved', () => {
    expect(resolveReferences([], [])).toEqual({ mode: 'none', effective: [] });
  });

  it('keeps one copy of an item that is both own and common', () => {
    expect(resolveReferences(['a', 'b'], ['b', 'c']).effective).toEqual(['a', 'b', 'c']);
  });
});
