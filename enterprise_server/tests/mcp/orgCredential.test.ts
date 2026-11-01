import { describe, expect, test } from 'vitest';

import { buildOrgCredentialHeaders } from '../../src/mcp/orgCredential';

describe('buildOrgCredentialHeaders', () => {
  test('defaults to Authorization: Bearer <key>', () => {
    expect(buildOrgCredentialHeaders('shared-key', { apiKey: 'k-1' })).toEqual({
      Authorization: 'Bearer k-1',
    });
  });

  test('a custom header name carries the raw key, no prefix', () => {
    expect(
      buildOrgCredentialHeaders('shared-key', { apiKey: 'k-1', apiKeyHeaderName: 'X-API-Key' }),
    ).toEqual({ 'X-API-Key': 'k-1' });
  });

  test('no key means no headers', () => {
    expect(buildOrgCredentialHeaders('shared-key', {})).toEqual({});
    expect(buildOrgCredentialHeaders('shared-key', { apiKey: '   ' })).toEqual({});
  });

  test('modes other than shared-key never leak a key', () => {
    expect(buildOrgCredentialHeaders('user-key', { apiKey: 'k-1' })).toEqual({});
    expect(buildOrgCredentialHeaders('none', { apiKey: 'k-1' })).toEqual({});
  });
});
