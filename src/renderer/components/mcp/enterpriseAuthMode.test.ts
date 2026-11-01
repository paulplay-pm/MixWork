import { describe, expect, test } from 'vitest';

import { McpAuthMethod } from '../../../shared/mcp/constants';
import {
  isGatewayAuthMode,
  isGatewayServer,
  isRetiredAuthMode,
  isRetiredServer,
  mapEnterpriseAuthModeToMcpAuthMethod,
} from './enterpriseAuthMode';

describe('mapEnterpriseAuthModeToMcpAuthMethod', () => {
  test('none → None (direct connect)', () => {
    expect(mapEnterpriseAuthModeToMcpAuthMethod('none')).toBe(McpAuthMethod.None);
  });
  test('user-key → ApiKey (user fills their own key)', () => {
    expect(mapEnterpriseAuthModeToMcpAuthMethod('user-key')).toBe(McpAuthMethod.ApiKey);
  });
  test('user-oauth → OAuth (existing browser flow)', () => {
    expect(mapEnterpriseAuthModeToMcpAuthMethod('user-oauth')).toBe(McpAuthMethod.OAuth);
  });
  test('shared-key maps to no local auth — the gateway injects the org key', () => {
    // It used to map to Bearer, which opened an authorize dialog asking the
    // member for a token only the org has. Now the desktop dials the
    // enterprise gateway, so the member supplies nothing.
    expect(mapEnterpriseAuthModeToMcpAuthMethod('shared-key')).toBe(McpAuthMethod.None);
  });
  test('client-creds maps to no local auth (same reason)', () => {
    expect(mapEnterpriseAuthModeToMcpAuthMethod('client-creds')).toBe(McpAuthMethod.None);
  });
  test('sso → OAuth (user-credential direct-link, reuses the generic OAuth driver)', () => {
    expect(mapEnterpriseAuthModeToMcpAuthMethod('sso')).toBe(McpAuthMethod.OAuth);
  });
  test('unknown value falls back to None (safe default, matches prior behavior)', () => {
    expect(mapEnterpriseAuthModeToMcpAuthMethod('nonsense' as never)).toBe(McpAuthMethod.None);
  });
});

describe('isGatewayAuthMode / isRetiredAuthMode', () => {
  test('shared-key is a gateway mode, not a retired one', () => {
    expect(isGatewayAuthMode('shared-key')).toBe(true);
    expect(isRetiredAuthMode('shared-key')).toBe(false);
  });

  test('client-creds is retired and not a gateway mode', () => {
    expect(isRetiredAuthMode('client-creds')).toBe(true);
    expect(isGatewayAuthMode('client-creds')).toBe(false);
  });

  test('the user-credential modes and none are neither', () => {
    for (const mode of ['user-oauth', 'user-key', 'sso', 'none']) {
      expect(isGatewayAuthMode(mode)).toBe(false);
      expect(isRetiredAuthMode(mode)).toBe(false);
    }
  });

  test('absent or unknown modes are neither', () => {
    for (const mode of [undefined, null, 'nonsense']) {
      expect(isGatewayAuthMode(mode)).toBe(false);
      expect(isRetiredAuthMode(mode)).toBe(false);
    }
  });
});

describe('isGatewayServer / isRetiredServer', () => {
  test('the catalog fallback still identifies an older local record', () => {
    // A record installed before the mode was persisted carries only serverKey.
    expect(isGatewayServer({ serverKey: 'sk' }, { sk: 'shared-key' })).toBe(true);
    expect(isRetiredServer({ serverKey: 'sk' }, { sk: 'client-creds' })).toBe(true);
    expect(isGatewayServer({ enterpriseAuthMode: 'user-key' })).toBe(false);
  });

  test('the persisted enterprise mode wins', () => {
    // The catalog entry may have changed since the install; the record is the
    // truth for what this desktop actually dials.
    expect(isGatewayServer({ enterpriseAuthMode: 'user-oauth', serverKey: 'sk' }, { sk: 'shared-key' })).toBe(false);
    expect(isGatewayServer({ enterpriseAuthMode: 'shared-key', serverKey: 'sk' }, { sk: 'client-creds' })).toBe(true);
  });

  test('a plain local server is neither', () => {
    expect(isGatewayServer({})).toBe(false);
    expect(isGatewayServer({ serverKey: 'crm' }, {})).toBe(false);
    expect(isRetiredServer({})).toBe(false);
    expect(isRetiredServer({ serverKey: 'crm' }, {})).toBe(false);
  });
});
