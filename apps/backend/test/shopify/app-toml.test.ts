import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { WEBHOOK_TOPICS } from '@rs/shared';
import { parseEnv } from '../../src/core/env';

// The Shopify configuration files must stay consistent with SPEC 8.1 and the backend env defaults.
// shopify.app.toml is the live backend-only setup; embedded/shopify.app.toml is the embedded web app setup.
const read = (relative: string): string => readFileSync(fileURLToPath(new URL(relative, import.meta.url)), 'utf8');
const live = read('../../shopify/shopify.app.toml');
const embedded = read('../../shopify/embedded/shopify.app.toml');
const env = parseEnv({});

const value = (toml: string, key: string): string => new RegExp(`^\\s*${key}\\s*=\\s*"([^"]*)"`, 'm').exec(toml)?.[1] ?? '';
const list = (toml: string, key: string): string[] =>
  [...(new RegExp(`^\\s*${key}\\s*=\\s*\\[([^\\]]*)\\]`, 'm').exec(toml)?.[1] ?? '').matchAll(/"([^"]*)"/g)].map((match) => match[1] ?? '');

describe.each([
  ['live', live],
  ['embedded', embedded],
])('shopify.app.toml (%s)', (_label, toml) => {
  it('is named Retailer Studio, without "Shopify" in the name', () => {
    expect(value(toml, 'name')).toBe('Retailer Studio');
    expect(value(toml, 'name').toLowerCase()).not.toContain('shopify');
  });

  it('has a real client id, and the same one in both files', () => {
    expect(value(toml, 'client_id')).toMatch(/^[0-9a-f]{32}$/);
    expect(value(toml, 'client_id')).toBe(value(live, 'client_id'));
  });

  it('keeps managed installation: no legacy install flow', () => {
    expect(toml).not.toMatch(/^\s*use_legacy_install_flow\s*=/m);
  });

  it('requests the same scopes as the backend and pins the same API version', () => {
    expect(value(toml, 'scopes')).toBe(env.SHOPIFY_SCOPES.join(','));
    expect(value(toml, 'scopes')).not.toContain('write_products');
    expect(value(toml, 'api_version')).toBe(env.SHOPIFY_API_VERSION);
  });

  it('subscribes the uninstall topic and the three compliance topics to /webhooks/shopify', () => {
    const topics = [...list(toml, 'topics'), ...list(toml, 'compliance_topics')];
    expect(topics.sort()).toEqual([...WEBHOOK_TOPICS].sort());
    // Relative (resolved against application_url) or absolute, the path is always /webhooks/shopify.
    const paths = [...toml.matchAll(/^\s*uri\s*=\s*"([^"]*)"/gm)].map((match) => new URL(match[1] ?? '', 'https://base.example').pathname);
    expect(paths).toEqual(['/webhooks/shopify', '/webhooks/shopify']);
  });

  it('keeps the backend callback as the only redirect URL', () => {
    // The mobile login runs the authorization code grant against the backend (PUBLIC_BASE_URL) in both setups.
    const redirects = list(toml, 'redirect_urls');
    expect(redirects).toHaveLength(1);
    expect(new URL(redirects[0] ?? 'https://invalid.example/').pathname).toBe(new URL('/auth/shopify/callback', env.PUBLIC_BASE_URL).pathname);
  });
});

describe('live configuration (backend only)', () => {
  it('is not embedded and opens the backend as the app URL', () => {
    expect(live).toMatch(/^embedded\s*=\s*false\s*$/m);
    const appUrl = new URL(value(live, 'application_url'));
    expect(appUrl.protocol).toBe('https:');
    expect(appUrl.pathname).toBe('/');
    // Webhook URIs are relative, so application_url must be the host that serves them and the OAuth callback.
    expect(new URL(list(live, 'redirect_urls')[0] ?? 'https://invalid.example/').host).toBe(appUrl.host);
  });

  it('has no placeholders left', () => {
    expect(live).not.toMatch(/REPLACE_WITH/);
  });
});

describe('embedded configuration (web app)', () => {
  it('is embedded and opens the web origin as the app URL', () => {
    expect(embedded).toMatch(/^embedded\s*=\s*true\s*$/m);
    const webUrl = new URL(value(embedded, 'application_url'));
    expect(webUrl.protocol).toBe('https:');
    expect(webUrl.pathname).toBe('/');
    // A separate service from the backend: the web app is what Shopify frames, the backend is called from it.
    expect(webUrl.host).not.toBe(new URL(value(live, 'application_url')).host);
  });

  it('sends the OAuth callback and the webhooks straight to the backend host of the live configuration', () => {
    const backendHost = new URL(value(live, 'application_url')).host;
    expect(new URL(list(embedded, 'redirect_urls')[0] ?? 'https://invalid.example/').host).toBe(backendHost);
    const uris = [...embedded.matchAll(/^\s*uri\s*=\s*"([^"]*)"/gm)].map((match) => match[1] ?? '');
    expect(uris).toEqual([`https://${backendHost}/webhooks/shopify`, `https://${backendHost}/webhooks/shopify`]);
  });

  it('has no placeholders left', () => {
    expect(embedded).not.toMatch(/REPLACE_WITH/);
  });
});
