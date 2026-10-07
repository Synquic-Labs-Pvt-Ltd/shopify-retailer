import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { WEBHOOK_TOPICS } from '@rs/shared';
import { parseEnv } from '../../src/core/env';

// shopify.app.toml must stay consistent with SPEC 8.1 and the backend env defaults.
const toml = readFileSync(fileURLToPath(new URL('../../shopify/shopify.app.toml', import.meta.url)), 'utf8');
const env = parseEnv({});

const value = (key: string): string => new RegExp(`^\\s*${key}\\s*=\\s*"([^"]*)"`, 'm').exec(toml)?.[1] ?? '';
const list = (key: string): string[] =>
  [...(new RegExp(`^\\s*${key}\\s*=\\s*\\[([^\\]]*)\\]`, 'm').exec(toml)?.[1] ?? '').matchAll(/"([^"]*)"/g)].map((match) => match[1] ?? '');

describe('shopify.app.toml', () => {
  it('is a non-embedded app named Retailer Studio, without "Shopify" in the name', () => {
    expect(toml).toMatch(/^embedded\s*=\s*false\s*$/m);
    expect(value('name')).toBe('Retailer Studio');
    expect(value('name').toLowerCase()).not.toContain('shopify');
  });

  it('uses PUBLIC_BASE_URL + "/" as the app URL and the callback as the only redirect URL', () => {
    expect(value('application_url')).toMatch(/^https:\/\/[^/]+\/$/);
    const base = value('application_url').slice(0, -1);
    expect(list('redirect_urls')).toEqual([`${base}/auth/shopify/callback`]);
  });

  it('requests the same scopes as the backend and pins the same API version', () => {
    expect(value('scopes')).toBe(env.SHOPIFY_SCOPES.join(','));
    expect(value('scopes')).not.toContain('write_products');
    expect(value('api_version')).toBe(env.SHOPIFY_API_VERSION);
  });

  it('subscribes the uninstall topic and the three compliance topics to /webhooks/shopify', () => {
    const topics = [...list('topics'), ...list('compliance_topics')];
    expect(topics.sort()).toEqual([...WEBHOOK_TOPICS].sort());
    expect([...toml.matchAll(/^\s*uri\s*=\s*"([^"]*)"/gm)].map((match) => match[1])).toEqual(['/webhooks/shopify', '/webhooks/shopify']);
  });
});
