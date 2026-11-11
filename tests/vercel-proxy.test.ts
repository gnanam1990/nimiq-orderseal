import { describe, expect, it } from 'vitest';
import { resolveUpstreamUrl } from '../api/proxy.js';

const origin = new URL('https://backend.example/');

describe('Vercel API proxy routing', () => {
  it('forwards nested API paths and preserves public query parameters', () => {
    expect(resolveUpstreamUrl(
      '/api/proxy?__orderseal_path=admin/orders/123/reconcile&limit=2',
      origin,
    )?.toString()).toBe('https://backend.example/api/admin/orders/123/reconcile?limit=2');
  });

  it('forwards single-segment API paths', () => {
    expect(resolveUpstreamUrl('/api/proxy?__orderseal_path=meta', origin)?.toString())
      .toBe('https://backend.example/api/meta');
  });

  it.each([
    '/api/proxy',
    '/api/proxy?__orderseal_path=',
    '/api/proxy?__orderseal_path=../health',
    '/api/proxy?__orderseal_path=admin%2F..%2Fhealth',
    '/api/proxy?__orderseal_path=admin\\orders',
  ])('rejects a missing or unsafe rewritten path: %s', (requestUrl) => {
    expect(resolveUpstreamUrl(requestUrl, origin)).toBeNull();
  });
});
