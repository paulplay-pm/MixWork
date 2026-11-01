import { describe, expect, test } from 'vitest';

import { AUDIT_ACTION_META } from '../../src/shared/auditActionMeta';
import { AuditTone } from '../../src/shared/auditActionMeta';
import { auditActionMeta } from '../../src/shared/auditActionMeta';
import { AuditAction } from '../../src/shared/enterpriseServerConstants';

describe('auditActionMeta', () => {
  test('covers every AuditAction code exactly', () => {
    const want = Object.values(AuditAction).sort();
    const got = Object.keys(AUDIT_ACTION_META).sort();
    expect(got).toEqual(want);
  });

  test('every entry has non-empty zh and en', () => {
    for (const [code, m] of Object.entries(AUDIT_ACTION_META)) {
      expect(m.zh.trim(), code).not.toBe('');
      expect(m.en.trim(), code).not.toBe('');
    }
  });

  test('no zh value equals its raw code', () => {
    for (const [code, m] of Object.entries(AUDIT_ACTION_META)) expect(m.zh, code).not.toBe(code);
  });

  test('destructive actions are tone danger', () => {
    for (const c of [AuditAction.ProviderKeyDelete, AuditAction.UserDisable, AuditAction.RoleDelete]) {
      expect(auditActionMeta(c).tone, c).toBe(AuditTone.Danger);
    }
  });

  // The code is `read_user_workspace`, but its only writer is
  // POST /admin/users/:id/impersonate — an admin assuming a user's identity.
  // Both the label and the tone are pinned so nobody softens the single
  // highest-signal row in the audit log.
  test('impersonation is labelled as impersonation and stays tone danger', () => {
    const m = auditActionMeta(AuditAction.ReadUserWorkspace);
    expect(m.zh).toBe('模拟登录用户');
    expect(m.en).toBe('Impersonated user');
    expect(m.tone).toBe(AuditTone.Danger);
  });

  test('login is tone auth', () => {
    expect(auditActionMeta(AuditAction.Login).tone).toBe(AuditTone.Auth);
  });

  test('an unregistered code falls back to itself without throwing', () => {
    const m = auditActionMeta('something_a_client_made_up');
    expect(m.zh).toBe('something_a_client_made_up');
    expect(m.en).toBe('something_a_client_made_up');
    expect(m.tone).toBe(AuditTone.Normal);
  });

  // `action` is client-controlled (POST /audit takes a bare z.string()), so a
  // plain-object index reaches Object.prototype and a `??` fallback never
  // fires: 'constructor' used to return a Function whose `zh` was undefined.
  test('prototype-chain names fall back instead of leaking Object.prototype', () => {
    for (const key of ['constructor', 'toString', 'hasOwnProperty', 'valueOf', '__proto__']) {
      const m = auditActionMeta(key);
      expect(m, key).toBeTypeOf('object');
      expect(m, key).not.toBeNull();
      expect(typeof m.zh, key).toBe('string');
      expect(m.zh, key).toBe(key);
      expect(m.en, key).toBe(key);
      expect(m.tone, key).toBe(AuditTone.Normal);
    }
  });

  test("auditActionMeta('constructor') is a real object with a non-empty zh", () => {
    const m = auditActionMeta('constructor');
    expect(Object.getPrototypeOf(m)).toBe(Object.prototype);
    expect(m.zh.trim()).not.toBe('');
  });
});