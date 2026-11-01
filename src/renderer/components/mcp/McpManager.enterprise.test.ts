import { afterAll, describe, expect, test } from 'vitest';

import { i18nService } from '../../services/i18n';
import {
  EnterpriseCardAction,
  enterpriseCardAction,
  EnterpriseOrgBadge,
  installedOrgBadge,
  orgKeyReady,
} from './connectorCardState';

describe('the enterprise market card', () => {
  test('a shared-key entry offers the normal install', () => {
    // The gateway injects the org key, so the member has nothing to supply and
    // nothing to authorize: installing is the whole flow.
    expect(enterpriseCardAction({ authMode: 'shared-key', installed: false }))
      .toBe(EnterpriseCardAction.Install);
    expect(enterpriseCardAction({ authMode: 'shared-key', installed: true }))
      .toBe(EnterpriseCardAction.Installed);
  });

  test('a client-creds entry still offers no install', () => {
    expect(enterpriseCardAction({ authMode: 'client-creds', installed: false }))
      .toBe(EnterpriseCardAction.Retired);
    // A stale record does not make the mode usable — the card keeps saying why.
    expect(enterpriseCardAction({ authMode: 'client-creds', installed: true }))
      .toBe(EnterpriseCardAction.Retired);
  });

  test('user-credential entries keep installing as before', () => {
    for (const mode of ['none', 'user-key', 'user-oauth', 'sso']) {
      expect(enterpriseCardAction({ authMode: mode, installed: false }))
        .toBe(EnterpriseCardAction.Install);
    }
  });
});

describe('the installed card badge', () => {
  test('a shared-key record is labelled gateway, not unavailable', () => {
    expect(installedOrgBadge({ enterpriseAuthMode: 'shared-key' })).toBe(EnterpriseOrgBadge.Gateway);
  });

  test('a record installed before the mode was persisted still gets the gateway badge', () => {
    expect(installedOrgBadge({ serverKey: 'sk' }, { sk: 'shared-key' })).toBe(EnterpriseOrgBadge.Gateway);
  });

  test('client-creds keeps the retired label', () => {
    expect(installedOrgBadge({ enterpriseAuthMode: 'client-creds' })).toBe(EnterpriseOrgBadge.Retired);
  });

  test('a plain installed connector has no badge', () => {
    expect(installedOrgBadge({})).toBeNull();
    expect(installedOrgBadge({ enterpriseAuthMode: 'user-oauth' })).toBeNull();
  });
});

describe('the detail panel org key status', () => {
  test('the catalog entry reports whether the key is stored', () => {
    expect(orgKeyReady({ orgCredentialReady: true })).toBe(true);
    expect(orgKeyReady({ orgCredentialReady: false })).toBe(false);
  });

  test('an entry absent from the catalog is not configured', () => {
    // The member is signed into a server whose catalog does not list the
    // connector any more; "not configured" is still the honest answer, and the
    // one that tells them who to ask.
    expect(orgKeyReady(undefined)).toBe(false);
    expect(orgKeyReady(null)).toBe(false);
  });
});

describe('the gateway copy exists in both languages', () => {
  const keys = [
    'mcpEnterpriseGatewayBadge',
    'mcpEnterpriseGatewayOrgCredential',
    'mcpEnterpriseGatewayHint',
    'mcpEnterpriseOrgManaged',
    'mcpDetailAuthorization',
    'mcpDetailOrgKey',
    'mcpDetailOrgKeyConfigured',
    'mcpDetailOrgKeyNotConfigured',
    'mcpDetailOrgKeyMissingNotice',
    'mcpGatewayErrorUpstreamUnauthorized',
    'mcpGatewayErrorForbidden',
    'mcpGatewayErrorNotFound',
    'mcpGatewayErrorUnsupportedTransport',
    'mcpGatewayErrorUpstreamInsecure',
    'mcpGatewayErrorUpstreamFailed',
    'mcpGatewayErrorCredentialUnavailable',
  ];
  const originalLanguage = i18nService.getLanguage();

  afterAll(() => {
    i18nService.setLanguage(originalLanguage, { persist: false });
  });

  test('neither language falls back to the key, and the two differ', () => {
    const copy: Record<string, { zh: string; en: string }> = {};
    i18nService.setLanguage('zh', { persist: false });
    for (const key of keys) copy[key] = { zh: i18nService.t(key), en: '' };
    i18nService.setLanguage('en', { persist: false });
    for (const key of keys) copy[key]!.en = i18nService.t(key);

    for (const key of keys) {
      expect(copy[key]!.zh).not.toBe(key);
      expect(copy[key]!.en).not.toBe(key);
      expect(copy[key]!.en).not.toBe(copy[key]!.zh);
    }
  });
});
