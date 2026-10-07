import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { DEV_DEFAULTS } from '../../src/core/env';
import { createSecretBox, parseEncKey } from '../../src/modules/shops/crypto';
import { parseScopes, scopesSatisfy } from '../../src/modules/shops/scopes';

describe('parseEncKey', () => {
  it('accepts 64 hex characters and 44-character base64', () => {
    const raw = randomBytes(32);
    expect(parseEncKey(raw.toString('hex')).equals(raw)).toBe(true);
    expect(parseEncKey(raw.toString('base64')).equals(raw)).toBe(true);
  });

  it('rejects a key that is not 32 bytes', () => {
    expect(() => parseEncKey('abcd')).toThrow(/32 bytes/);
  });
});

describe('createSecretBox (AES-256-GCM)', () => {
  const box = createSecretBox(DEV_DEFAULTS.TOKEN_ENC_KEY);

  it('round-trips and uses the base64 iv:tag:cipher layout', () => {
    const blob = box.encrypt('shpat_secret_value');
    expect(blob).not.toContain('shpat_secret_value');
    const parts = blob.split(':');
    expect(parts).toHaveLength(3);
    expect(Buffer.from(parts[0] ?? '', 'base64')).toHaveLength(12);
    expect(Buffer.from(parts[1] ?? '', 'base64')).toHaveLength(16);
    expect(box.decrypt(blob)).toBe('shpat_secret_value');
  });

  it('uses a fresh IV for every encryption', () => {
    expect(box.encrypt('same')).not.toBe(box.encrypt('same'));
  });

  it('rejects tampered ciphertext, a tampered tag and the wrong key', () => {
    const [iv = '', tag = '', cipher = ''] = box.encrypt('shpat_secret_value').split(':');
    const flip = (value: string): string => {
      const bytes = Buffer.from(value, 'base64');
      bytes[0] = (bytes[0] ?? 0) ^ 0xff;
      return bytes.toString('base64');
    };
    expect(() => box.decrypt([iv, tag, flip(cipher)].join(':'))).toThrow();
    expect(() => box.decrypt([iv, flip(tag), cipher].join(':'))).toThrow();

    const other = createSecretBox(randomBytes(32).toString('hex'));
    expect(() => other.decrypt(box.encrypt('x'))).toThrow();
  });

  it('rejects malformed blobs', () => {
    expect(() => box.decrypt('nope')).toThrow(/Malformed/);
    expect(() => box.decrypt('a:b:c')).toThrow(/Malformed/);
  });
});

describe('scopes', () => {
  it('parses the comma-separated list', () => {
    expect(parseScopes('read_products, read_files,,write_files')).toEqual(['read_products', 'read_files', 'write_files']);
    expect(parseScopes(undefined)).toEqual([]);
  });

  it('treats a write scope as covering its read scope', () => {
    expect(scopesSatisfy(['read_products', 'write_files'], ['read_products', 'read_files', 'write_files'])).toBe(true);
    expect(scopesSatisfy(['read_products'], ['read_products', 'write_files'])).toBe(false);
    expect(scopesSatisfy([], ['read_products'])).toBe(false);
  });
});
