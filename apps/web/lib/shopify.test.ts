import { describe, expect, it } from 'vitest';
import { adminAppUrl, readShopParam, waitFor } from './shopify';

describe('readShopParam', () => {
  it('reads a myshopify shop from the query string', () => {
    expect(readShopParam('?hmac=abc&shop=gluzu.myshopify.com&host=x')).toBe('gluzu.myshopify.com');
  });

  it('rejects a missing shop or any other host', () => {
    for (const search of ['', '?host=x', '?shop=', '?shop=evil.example.com', '?shop=gluzu.myshopify.com.evil.com', '?shop=https://gluzu.myshopify.com', '?shop=-bad.myshopify.com']) {
      expect(readShopParam(search)).toBeNull();
    }
  });
});

describe('adminAppUrl', () => {
  it('points at the app inside the shop admin', () => {
    expect(adminAppUrl('gluzu.myshopify.com', 'a8fb46c0913fdaa1de8b0c5d2e4f6a71')).toBe('https://gluzu.myshopify.com/admin/apps/a8fb46c0913fdaa1de8b0c5d2e4f6a71');
  });

  it('encodes the key so it cannot change the path', () => {
    expect(adminAppUrl('gluzu.myshopify.com', 'a/../b?x=1')).toBe('https://gluzu.myshopify.com/admin/apps/a%2F..%2Fb%3Fx%3D1');
  });
});

describe('waitFor', () => {
  it('returns at once when the value is there', async () => {
    const sleep = async () => {
      throw new Error('must not sleep');
    };
    expect(await waitFor(() => 'ready', 1000, 100, sleep)).toBe('ready');
  });

  it('waits for a value that appears later', async () => {
    let calls = 0;
    const sleep = async () => {
      calls += 1;
    };
    expect(await waitFor(() => (calls >= 3 ? 'late' : undefined), 5000, 100, sleep)).toBe('late');
    expect(calls).toBe(3);
  });

  it('gives up after the timeout', async () => {
    let slept = 0;
    const sleep = async (ms: number) => {
      slept += ms;
    };
    expect(await waitFor(() => undefined, 500, 100, sleep)).toBeUndefined();
    expect(slept).toBe(500);
  });
});
