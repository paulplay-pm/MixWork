import { describe, expect, test } from 'vitest';

import {
  buildConnectorSubmitRequest,
  requiredAuthFields,
  SUBMIT_AUTH_MODES,
} from './submitConnectorDraft';

const base = {
  serverKey: 'crm',
  url: 'https://crm.example.com/mcp',
  nameEn: 'CRM',
  nameZh: '',
  version: '1.0.0',
  categoryId: '',
  description: '',
  transport: 'http' as const,
  authMode: 'none' as const,
  clientId: '',
  authorizeUrl: '',
  tokenUrl: '',
};

describe('member-submittable auth modes', () => {
  test('org-credential modes are not offered to a member', () => {
    // Both need a credential the org owns. A member proposing one would have
    // to hand over a secret they should not be handing over, and the desktop
    // could not use the connector anyway.
    expect(SUBMIT_AUTH_MODES).not.toContain('shared-key');
    expect(SUBMIT_AUTH_MODES).not.toContain('client-creds');
  });

  test('sso is still admin-only', () => {
    expect(SUBMIT_AUTH_MODES).not.toContain('sso');
  });

  test('the per-user modes remain', () => {
    expect(SUBMIT_AUTH_MODES).toContain('none');
    expect(SUBMIT_AUTH_MODES).toContain('user-key');
    expect(SUBMIT_AUTH_MODES).toContain('user-oauth');
  });
});

describe('requiredAuthFields', () => {
  test('user-oauth needs nothing: the desktop discovers the provider and registers a client', () => {
    expect(requiredAuthFields('user-oauth')).toEqual([]);
  });

  test('user-key and none need nothing here — the member fills those in locally', () => {
    expect(requiredAuthFields('user-key')).toEqual([]);
    expect(requiredAuthFields('none')).toEqual([]);
  });
});

describe('buildConnectorSubmitRequest', () => {
  test('user-oauth sends the public-client config and no secret', () => {
    const cfg = buildConnectorSubmitRequest({
      ...base,
      authMode: 'user-oauth',
      clientId: 'cid',
      authorizeUrl: 'https://idp.example.com/authorize',
      tokenUrl: 'https://idp.example.com/token',
    });
    expect(cfg.authMode).toBe('user-oauth');
    expect(cfg.authConfig).toEqual({
      clientId: 'cid',
      authorizeUrl: 'https://idp.example.com/authorize',
      tokenUrl: 'https://idp.example.com/token',
    });
  });

  test('the config carries only the fields its mode uses', () => {
    const cfg = buildConnectorSubmitRequest({
      ...base,
      clientId: 'left-over',
      authorizeUrl: 'https://left-over.example.com/authorize',
    });
    expect(cfg.authConfig).toEqual({});
  });

  test('optional text is omitted rather than sent empty, and scope is the whole company', () => {
    const cfg = buildConnectorSubmitRequest({ ...base, nameEn: '  ', description: 'hi' });
    expect(cfg).not.toHaveProperty('nameEn');
    expect(cfg.nameZh).toBeUndefined();
    expect(cfg.description).toBe('hi');
    expect(cfg.version).toBe('1.0.0');
    expect(cfg.categoryId).toBeNull();
    expect(cfg.scope).toEqual({ allCompany: true });
    expect(cfg.serverKey).toBe('crm');
  });
});
