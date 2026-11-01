import { afterAll, describe, expect, test } from 'vitest';

import { ConnectorConsumption, McpAuthMethod } from '../../../shared/mcp/constants';
import { i18nService } from '../../services/i18n';
import {
  authMethodIsReadOnly,
  consumptionForEntry,
  enterpriseAuthMethodForForm,
  gatewayUrlIsReadOnly,
} from './connectorCardState';
import { enterpriseAuthModeLabelKey } from './enterpriseAuthMode';

describe('the install form for an enterprise connector', () => {
  test('a shared-key entry installs through the gateway', () => {
    expect(consumptionForEntry({ authMode: 'shared-key', consumption: 'gateway' }))
      .toBe(ConnectorConsumption.Gateway);
  });

  test('a server that predates the consumption field still installs through the gateway', () => {
    // The field is the server's answer; silence must not turn a gateway
    // connector into a direct dial that can only 401.
    expect(consumptionForEntry({ authMode: 'shared-key' })).toBe(ConnectorConsumption.Gateway);
  });

  test('every other mode is direct', () => {
    for (const authMode of ['none', 'user-key', 'user-oauth', 'sso', 'client-creds']) {
      expect(consumptionForEntry({ authMode })).toBe(ConnectorConsumption.Direct);
    }
    // An explicit answer wins, even one this build would not have derived.
    expect(consumptionForEntry({ authMode: 'user-key', consumption: 'direct' }))
      .toBe(ConnectorConsumption.Direct);
  });

  test('a gateway url is read-only in both install and edit', () => {
    expect(gatewayUrlIsReadOnly({ entry: { authMode: 'shared-key' } })).toBe(true);
    expect(gatewayUrlIsReadOnly({ record: { enterpriseAuthMode: 'shared-key' } })).toBe(true);
  });

  test('a user-credential connector keeps an editable url', () => {
    expect(gatewayUrlIsReadOnly({ entry: { authMode: 'user-oauth' } })).toBe(false);
    expect(gatewayUrlIsReadOnly({ record: { enterpriseAuthMode: 'user-key' } })).toBe(false);
    expect(gatewayUrlIsReadOnly({})).toBe(false);
  });
});

describe('the read-only url explanation', () => {
  const originalLanguage = i18nService.getLanguage();

  afterAll(() => {
    i18nService.setLanguage(originalLanguage, { persist: false });
  });

  test('exists in both languages', () => {
    i18nService.setLanguage('zh', { persist: false });
    const zh = i18nService.t('mcpGatewayUrlReadOnly');
    i18nService.setLanguage('en', { persist: false });
    const en = i18nService.t('mcpGatewayUrlReadOnly');
    expect(zh).not.toBe('mcpGatewayUrlReadOnly');
    expect(en).not.toBe('mcpGatewayUrlReadOnly');
    expect(en).not.toBe(zh);
  });
});

describe('the enterprise auth method row', () => {
  test('the auth method is read-only for any enterprise connector', () => {
    // The mode is the org's decision. `shared-key` only works through the
    // gateway, `user-key` means the member fills a header the admin named —
    // a member who could switch it would install a connector that dials with
    // the wrong credential.
    expect(authMethodIsReadOnly({ entry: { authMode: 'shared-key' } })).toBe(true);
    expect(authMethodIsReadOnly({ entry: { authMode: 'user-key' } })).toBe(true);
    expect(authMethodIsReadOnly({ entry: { authMode: 'user-oauth' } })).toBe(true);
    expect(authMethodIsReadOnly({ entry: { authMode: 'none' } })).toBe(true);
    expect(authMethodIsReadOnly({ record: { enterpriseAuthMode: 'user-key' } })).toBe(true);
    // A record installed before the mode was persisted still knows it came
    // from the org: it carries the server key.
    expect(authMethodIsReadOnly({ record: { serverKey: 'crm' } })).toBe(true);
  });

  test("a connector of the member's own keeps an editable auth method", () => {
    expect(authMethodIsReadOnly({})).toBe(false);
    expect(authMethodIsReadOnly({ entry: null, record: null })).toBe(false);
    expect(authMethodIsReadOnly({ record: { serverKey: null } })).toBe(false);
  });

  test('the method shown is the org\'s, mapped to what the desktop stores', () => {
    expect(enterpriseAuthMethodForForm({ entry: { authMode: 'user-key' } }))
      .toBe(McpAuthMethod.ApiKey);
    expect(enterpriseAuthMethodForForm({ entry: { authMode: 'user-oauth' } }))
      .toBe(McpAuthMethod.OAuth);
    expect(enterpriseAuthMethodForForm({ entry: { authMode: 'sso' } }))
      .toBe(McpAuthMethod.OAuth);
    // The gateway injects the org key: the member holds no credential at all.
    expect(enterpriseAuthMethodForForm({ entry: { authMode: 'shared-key' } }))
      .toBe(McpAuthMethod.None);
    expect(enterpriseAuthMethodForForm({ record: { enterpriseAuthMode: 'user-key' } }))
      .toBe(McpAuthMethod.ApiKey);
    // Not an enterprise connector: the form keeps whatever it had.
    expect(enterpriseAuthMethodForForm({})).toBeNull();
  });

  test('every org mode has its own label, so a shared key is not shown as "none"', () => {
    expect(enterpriseAuthModeLabelKey('shared-key')).toBe('mcpEnterpriseAuthModeSharedKey');
    expect(enterpriseAuthModeLabelKey('client-creds')).toBe('mcpEnterpriseAuthModeClientCreds');
    expect(enterpriseAuthModeLabelKey('user-key')).toBe('mcpEnterpriseAuthModeUserKey');
    expect(enterpriseAuthModeLabelKey('user-oauth')).toBe('mcpEnterpriseAuthModeOAuth');
    expect(enterpriseAuthModeLabelKey('sso')).toBe('mcpEnterpriseAuthModeOAuth');
    expect(enterpriseAuthModeLabelKey('none')).toBe('mcpEnterpriseAuthModeNone');
    // A mode this build does not know has no label: the caller falls back to
    // the generic method label rather than inventing one.
    expect(enterpriseAuthModeLabelKey('brand-new-mode')).toBeNull();
    expect(enterpriseAuthModeLabelKey(null)).toBeNull();
  });
});

describe('the enterprise auth copy', () => {
  const originalLanguage = i18nService.getLanguage();

  afterAll(() => {
    i18nService.setLanguage(originalLanguage, { persist: false });
  });

  test('the labels and the read-only note exist in both languages', () => {
    const keys = [
      'mcpEnterpriseAuthModeSharedKey',
      'mcpEnterpriseAuthModeClientCreds',
      'mcpEnterpriseAuthModeUserKey',
      'mcpEnterpriseAuthModeOAuth',
      'mcpEnterpriseAuthModeNone',
      'mcpAuthMethodEnterpriseManaged',
    ];
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
