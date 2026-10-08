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
  it('is an embedded app named Retailer Studio, without "Shopify" in the name', () => {
    expect(toml).toMatch(/^embedded\s*=\s*true\s*$/m);
    expect(value('name')).toBe('Retailer Studio');
    expect(value('name').toLowerCase()).not.toContain('shopify');
  });

  it('opens the web origin as the app URL and keeps the backend callback as the only redirect URL', () => {
    expect(value('application_url')).toBe('https://REPLACE_WITH_WEB_ORIGIN/');
    // The mobile login still runs the authorization code grant against the backend (PUBLIC_BASE_URL).
    const redirects = list('redirect_urls');
    expect(redirects).toEqual(['https://REPLACE_WITH_PUBLIC_BASE_URL/auth/shopify/callback']);
    expect(new URL(redirects[0] ?? '').pathname).toBe(new URL('/auth/shopify/callback', env.PUBLIC_BASE_URL).pathname);
  });

  it('keeps managed installation: no legacy install flow', () => {
    expect(toml).not.toMatch(/^\s*use_legacy_install_flow\s*=/m);
  });

  it('documents why the web origin must proxy the Shopify routes', () => {
    expect(toml).toMatch(/embedded = true/);
    expect(toml).toMatch(/proxy \/webhooks\/shopify/);
    expect(toml).toMatch(/\/auth\/shopify\/\*/);
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
