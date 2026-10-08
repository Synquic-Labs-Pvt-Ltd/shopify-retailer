import { describe, expect, it } from 'vitest';
import { DEV_DEFAULTS, EnvValidationError, mongoDbName, parseEnv, parseServiceAccountJson } from '../src/core/env';

const productionEnv = {
  NODE_ENV: 'production',
  PUBLIC_BASE_URL: 'https://studio.example.com/',
  JWT_SECRET: 'a'.repeat(48),
  TOKEN_ENC_KEY: 'f'.repeat(64),
  SHOPIFY_API_KEY: 'real-key',
  SHOPIFY_API_SECRET: 'real-secret',
};

const serviceAccount = {
  type: 'service_account',
  project_id: 'demo-project',
  client_email: 'svc@demo-project.iam.gserviceaccount.com',
  private_key: '-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----\n',
};

describe('mongoDbName', () => {
  it('keeps the database named in the URI', () => {
    expect(mongoDbName({ MONGODB_URI: 'mongodb://u:p@mongo:27017/studio?authSource=admin' })).toBeUndefined();
    expect(mongoDbName({ MONGODB_URI: 'mongodb+srv://u:p@cluster.example.net/prod?retryWrites=true' })).toBeUndefined();
  });

  it('falls back to MONGODB_DB_NAME, then retailer-studio, when the URI names none', () => {
    for (const uri of ['mongodb://root:pw@mongo:27017/', 'mongodb://root:pw@mongo:27017', 'mongodb://root:pw@mongo:27017/?authSource=admin', 'mongodb+srv://u:p@cluster.example.net/?retryWrites=true']) {
      expect(mongoDbName({ MONGODB_URI: uri })).toBe('retailer-studio');
      expect(mongoDbName({ MONGODB_URI: uri, MONGODB_DB_NAME: 'custom' })).toBe('custom');
    }
  });

  it('accepts Synq style bare connection strings in production validation', () => {
    const env = parseEnv({ ...productionEnv, MONGODB_URI: 'mongodb://root:secret@mongo:27017/' });
    expect(mongoDbName(env)).toBe('retailer-studio');
  });
});

describe('GOOGLE_SERVICE_ACCOUNT_JSON', () => {
  it('accepts the key as raw JSON or as base64', () => {
    const json = JSON.stringify(serviceAccount);
    expect(parseServiceAccountJson(json)?.project_id).toBe('demo-project');
    expect(parseServiceAccountJson(Buffer.from(json).toString('base64'))?.client_email).toBe(serviceAccount.client_email);
    expect(parseEnv({ GOOGLE_SERVICE_ACCOUNT_JSON: json }).GOOGLE_SERVICE_ACCOUNT_JSON).toBe(json);
  });

  it('rejects anything that is not a service-account key without echoing the value', () => {
    expect(parseServiceAccountJson('not json')).toBeNull();
    expect(parseServiceAccountJson(JSON.stringify({ type: 'authorized_user' }))).toBeNull();
    const secretish = JSON.stringify({ type: 'service_account', private_key: 'TOP-SECRET-VALUE' });
    try {
      parseEnv({ GOOGLE_SERVICE_ACCOUNT_JSON: secretish });
      throw new Error('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(EnvValidationError);
      expect((err as EnvValidationError).message).not.toContain('TOP-SECRET-VALUE');
      expect((err as EnvValidationError).issues[0]).toContain('GOOGLE_SERVICE_ACCOUNT_JSON');
    }
  });
});

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
