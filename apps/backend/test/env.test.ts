import { describe, expect, it } from 'vitest';
import { DEV_DEFAULTS, EnvValidationError, parseEnv } from '../src/core/env';

const productionEnv = {
  NODE_ENV: 'production',
  PUBLIC_BASE_URL: 'https://studio.example.com/',
  JWT_SECRET: 'a'.repeat(48),
  TOKEN_ENC_KEY: 'f'.repeat(64),
  SHOPIFY_API_KEY: 'real-key',
  SHOPIFY_API_SECRET: 'real-secret',
};

describe('parseEnv', () => {
  it('applies development defaults for an empty environment', () => {
    const env = parseEnv({});
    expect(env.NODE_ENV).toBe('development');
    expect(env.PORT).toBe(3000);
    expect(env.ROLE).toBe('all');
    expect(env.SHOPIFY_API_VERSION).toBe('2026-10');
    expect(env.SHOPIFY_SCOPES).toEqual(['read_products', 'read_files', 'write_files']);
    expect(env.JWT_SECRET).toBe(DEV_DEFAULTS.JWT_SECRET);
  });

  it('coerces and normalizes explicit values', () => {
    const env = parseEnv({
      PORT: '4100',
      ROLE: 'worker',
      PUBLIC_BASE_URL: 'https://example.com//',
      SHOPIFY_SCOPES: 'read_products, read_files',
      LOG_LEVEL: 'debug',
    });
    expect(env.PORT).toBe(4100);
    expect(env.ROLE).toBe('worker');
    expect(env.PUBLIC_BASE_URL).toBe('https://example.com');
    expect(env.SHOPIFY_SCOPES).toEqual(['read_products', 'read_files']);
    expect(env.LOG_LEVEL).toBe('debug');
  });

  it('treats empty strings as unset', () => {
    const env = parseEnv({ GEMINI_API_KEY: '', JWT_SECRET: '' });
    expect(env.GEMINI_API_KEY).toBeUndefined();
    expect(env.JWT_SECRET).toBe(DEV_DEFAULTS.JWT_SECRET);
  });

  it('lists every invalid variable in one error', () => {
    let error: unknown;
    try {
      parseEnv({ PORT: 'abc', ROLE: 'nope', MONGODB_URI: 'http://wrong', TOKEN_ENC_KEY: 'short' });
    } catch (err) {
      error = err;
    }
    expect(error).toBeInstanceOf(EnvValidationError);
    const message = (error as EnvValidationError).message;
    expect(message).toContain('PORT');
    expect(message).toContain('ROLE');
    expect(message).toContain('MONGODB_URI');
    expect(message).toContain('TOKEN_ENC_KEY');
  });

  it('accepts a complete production environment', () => {
    const env = parseEnv(productionEnv);
    expect(env.NODE_ENV).toBe('production');
    expect(env.PUBLIC_BASE_URL).toBe('https://studio.example.com');
  });

  it('refuses development defaults and http in production', () => {
    let error: unknown;
    try {
      parseEnv({ NODE_ENV: 'production' });
    } catch (err) {
      error = err;
    }
    expect(error).toBeInstanceOf(EnvValidationError);
    const issues = (error as EnvValidationError).issues.join('\n');
    for (const key of ['PUBLIC_BASE_URL', 'JWT_SECRET', 'TOKEN_ENC_KEY', 'SHOPIFY_API_KEY', 'SHOPIFY_API_SECRET']) {
      expect(issues).toContain(key);
    }
  });
});
