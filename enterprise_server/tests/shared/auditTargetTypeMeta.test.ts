import { describe, expect, test } from 'vitest';

import {
  AUDIT_TARGET_TYPE_META,
  auditTargetTypeMeta,
  KNOWN_TARGET_TYPES,
} from '../../src/shared/auditTargetTypeMeta';

describe('auditTargetTypeMeta', () => {
  test('covers the 23 known target types', () => {
    expect(Object.keys(AUDIT_TARGET_TYPE_META).sort()).toEqual([
      'agent','agent_references','archive','connector','connector_category','dept',
      'enterprise_models_sync','html_share','kit','kit_category','login','model','org',
      'provider_card','provider_key','release','role','route','skill','skill_category',
      'sso_connection','submission','user',
    ]);
  });

  test('KNOWN_TARGET_TYPES agrees with the table it types', () => {
    expect([...KNOWN_TARGET_TYPES].sort()).toEqual(Object.keys(AUDIT_TARGET_TYPE_META).sort());
  });

  test('every entry has zh and en', () => {
    for (const [k, m] of Object.entries(AUDIT_TARGET_TYPE_META)) {
      expect(m.zh.trim(), k).not.toBe('');
      expect(m.en.trim(), k).not.toBe('');
    }
  });

  test('null yields null (the UI renders an em dash)', () => {
    expect(auditTargetTypeMeta(null)).toBeNull();
  });

  test('an unknown client-supplied value falls back to itself', () => {
    expect(auditTargetTypeMeta('whatever')!.zh).toBe('whatever');
  });

  test('the fallback carries the raw value through for the audit filter', () => {
    const m = auditTargetTypeMeta('client_invented');
    expect(m).toEqual({ value: 'client_invented', zh: 'client_invented', en: 'client_invented' });
  });

  // `targetType` is client-controlled (POST /audit takes a bare z.string()), so
  // a plain-object index reaches Object.prototype and the `??` fallback never
  // fires: 'toString' used to spread a Function into the result, leaving zh
  // and en undefined — the blank cell this accessor promises never to render.
  test('prototype-chain names fall back instead of leaking Object.prototype', () => {
    for (const key of ['constructor', 'toString', 'hasOwnProperty', 'valueOf', '__proto__']) {
      expect(auditTargetTypeMeta(key), key).toEqual({ value: key, zh: key, en: key });
    }
  });

  test('every resolved value carries a non-empty zh and en', () => {
    for (const key of [
      ...KNOWN_TARGET_TYPES,
      'constructor',
      'toString',
      'hasOwnProperty',
      'valueOf',
      '__proto__',
      'client_invented',
    ]) {
      const m = auditTargetTypeMeta(key)!;
      expect(m.zh.trim(), key).not.toBe('');
      expect(m.en.trim(), key).not.toBe('');
    }
  });
});