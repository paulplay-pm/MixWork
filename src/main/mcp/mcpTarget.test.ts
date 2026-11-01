import { describe, expect, test, vi } from 'vitest';

vi.mock('../libs/endpoints', () => ({
  getServerApiBaseUrl: () => {
    const v = process.env.ENTERPRISE_SERVER_URL;
    if (!v) throw new Error('ENTERPRISE_SERVER_URL is not configured');
    return v.replace(/\/+$/, '');
  },
}));

import {
  enterpriseBaseUrlOrNull,
  gatewayUrlFor,
  resolveMcpTarget,
} from './mcpTarget';

const gw = (over: Partial<Parameters<typeof resolveMcpTarget>[0]> = {}) => ({
  url: 'https://up.example/mcp',
  consumption: 'gateway' as const,
  serverKey: 'sk-1',
  gatewayToken: 'gsj-1',
  ...over,
});

describe('resolveMcpTarget', () => {
  test('a gateway record points at the enterprise gateway with the gsj', () => {
    expect(resolveMcpTarget(gw(), { enterpriseBaseUrl: 'https://ent' })).toEqual({
      url: 'https://ent/mcp/gateway/sk-1',
      headers: { authorization: 'McpGateway gsj-1' },
    });
  });

  test('missing base url, server key or token yields null — never the upstream', () => {
    // Returning the record's own url here would send the request to the
    // vendor with no org credential at all: worse than a visible failure.
    expect(resolveMcpTarget(gw(), { enterpriseBaseUrl: null })).toBeNull();
    expect(resolveMcpTarget(gw({ serverKey: undefined }), { enterpriseBaseUrl: 'https://ent' })).toBeNull();
    expect(resolveMcpTarget(gw({ gatewayToken: undefined }), { enterpriseBaseUrl: 'https://ent' })).toBeNull();
  });

  test('a direct record is unchanged', () => {
    expect(
      resolveMcpTarget({ url: 'https://up/mcp', headers: { 'x-a': 'b' } }, { enterpriseBaseUrl: null }),
    ).toEqual({ url: 'https://up/mcp', headers: { 'x-a': 'b' } });
  });

  test('a record with no url has no target', () => {
    expect(resolveMcpTarget({ consumption: 'direct' }, { enterpriseBaseUrl: 'https://ent' })).toBeNull();
  });

  test('the server key is path-encoded', () => {
    expect(gatewayUrlFor('https://ent', 'a b')).toBe('https://ent/mcp/gateway/a%20b');
  });

  test('a trailing slash on the base url does not double up', () => {
    expect(gatewayUrlFor('https://ent/', 'sk-1')).toBe('https://ent/mcp/gateway/sk-1');
  });
});

describe('enterpriseBaseUrlOrNull', () => {
  test('is null when the build has no enterprise server, rather than throwing', () => {
    delete process.env.ENTERPRISE_SERVER_URL;
    expect(enterpriseBaseUrlOrNull()).toBeNull();
    process.env.ENTERPRISE_SERVER_URL = 'https://ent/';
    expect(enterpriseBaseUrlOrNull()).toBe('https://ent');
  });
});
