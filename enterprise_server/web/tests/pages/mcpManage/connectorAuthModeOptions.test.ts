import { describe, expect, test } from 'vitest';

import {
  DATA_ONLY_AUTH_MODES,
  isSelectableAuthMode,
  normalizeLegacyAuthMode,
  readOAuthFields,
  SELECTABLE_AUTH_MODES,
  serverCanDiscoverTools,
} from '../../../src/pages/mcpManage/connectorAuthModeOptions';

describe('selectable auth modes', () => {
  test('the picker offers exactly none / shared-key / user-key / user-oauth', () => {
    expect(SELECTABLE_AUTH_MODES).toEqual(['none', 'shared-key', 'user-key', 'user-oauth']);
  });

  test('client-creds is retired and sso is folded into user-oauth', () => {
    expect(isSelectableAuthMode('client-creds')).toBe(false);
    expect(isSelectableAuthMode('sso')).toBe(false);
    expect(DATA_ONLY_AUTH_MODES).toEqual(['client-creds', 'sso']);
  });

  test('the live modes stay selectable', () => {
    expect(SELECTABLE_AUTH_MODES.every(isSelectableAuthMode)).toBe(true);
  });
});

describe('normalizeLegacyAuthMode', () => {
  test('sso opens as user-oauth, everything else is itself', () => {
    expect(normalizeLegacyAuthMode('sso')).toBe('user-oauth');
    expect(normalizeLegacyAuthMode('client-creds')).toBe('client-creds');
    expect(normalizeLegacyAuthMode('shared-key')).toBe('shared-key');
  });
});

describe('readOAuthFields', () => {
  test('an sso connector reads its sso-prefixed fields into the bare ones', () => {
    expect(
      readOAuthFields('sso', {
        ssoClientId: 'cid',
        ssoAuthorizeUrl: 'https://idp/a',
        ssoTokenUrl: 'https://idp/t',
        ssoScopes: ['openid'],
      }),
    ).toEqual({
      clientId: 'cid',
      authorizeUrl: 'https://idp/a',
      tokenUrl: 'https://idp/t',
      scopes: ['openid'],
    });
  });

  test('bare values win when both spellings are present', () => {
    const f = readOAuthFields('sso', {
      clientId: 'bare',
      ssoClientId: 'legacy',
      authorizeUrl: 'https://bare/a',
    });
    expect(f.clientId).toBe('bare');
    expect(f.authorizeUrl).toBe('https://bare/a');
  });

  test('a non-sso connector never picks up sso leftovers', () => {
    expect(readOAuthFields('user-oauth', { ssoClientId: 'legacy' }).clientId).toBe('');
  });
});

describe('serverCanDiscoverTools', () => {
  test('the org can list the tools of a connector whose credential it holds', () => {
    expect(serverCanDiscoverTools('none')).toBe(true);
    expect(serverCanDiscoverTools('shared-key')).toBe(true);
  });

  test('a member credential leaves the server with nothing to authenticate with', () => {
    expect(serverCanDiscoverTools('user-key')).toBe(false);
    expect(serverCanDiscoverTools('user-oauth')).toBe(false);
    expect(serverCanDiscoverTools('sso')).toBe(false);
    expect(serverCanDiscoverTools('client-creds')).toBe(false);
  });
});
