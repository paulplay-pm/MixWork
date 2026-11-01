import { describe, expect, test } from 'vitest';

import { setLang, t } from '../../src/i18n';
import {
  DATA_SCOPE_VALUES,
  dataScopeLabelKey,
  moduleLabelKey,
  PERMISSION_MODULES,
  PERMISSION_POINTS,
  pointLabelKey,
} from '../../src/shared/permissions';

describe('fine-grained permission catalog', () => {
  test('catalog is intact: 51 unique points grouped into the 13 modules', () => {
    expect(PERMISSION_POINTS).toHaveLength(51);
    expect(PERMISSION_MODULES).toHaveLength(13);
    // Points that were the subject of the coarse→fine migration.
    expect(PERMISSION_POINTS).toContain('dept:adjust_member');
    expect(PERMISSION_POINTS).toContain('provider:rotate');
    expect(PERMISSION_POINTS).toContain('agent:publish');
    // No duplicates, and the module grouping covers exactly the catalog.
    expect(new Set(PERMISSION_POINTS).size).toBe(PERMISSION_POINTS.length);
    expect(PERMISSION_MODULES.map((m) => m.points).flat()).toEqual(PERMISSION_POINTS);
  });

  test('usage points are registered and grouped by a usage module', () => {
    expect(PERMISSION_POINTS).toContain('usage:view');
    expect(PERMISSION_POINTS).toContain('usage:export');
    const usage = PERMISSION_MODULES.find((m) => m.key === 'usage');
    expect(usage).toBeDefined();
    expect(usage!.points).toEqual(['usage:view', 'usage:export']);
  });

  test('data scope values', () => {
    expect(DATA_SCOPE_VALUES).toEqual([
      'org_wide',
      'dept_and_below',
      'dept',
      'self',
      'custom_dept_tree',
    ]);
  });

  test('every module, point and data scope label resolves in both languages', () => {
    // PermissionGroupTree renders t(moduleLabelKey(...)) / t(pointLabelKey(...))
    // / t(dataScopeLabelKey(...)) with no fallback of its own, and t() falls
    // back to `en` and then to the literal key — so a catalog entry with no
    // label renders a raw key to admins.
    // Merely asserting "resolves to a non-key string" would NOT catch a key
    // missing from just one dictionary: the other language's fallback answers.
    // Every zh label contains CJK and no en label does, so the script of the
    // resolved string pins which dictionary actually served it.
    const keys = [
      ...PERMISSION_MODULES.map((m) => moduleLabelKey(m.key)),
      ...PERMISSION_MODULES.flatMap((m) => m.points.map(pointLabelKey)),
      ...DATA_SCOPE_VALUES.map(dataScopeLabelKey),
    ];
    for (const lang of ['en', 'zh'] as const) {
      setLang(lang);
      for (const k of keys) {
        const label = t(k);
        expect(label, `${lang} ${k}`).not.toBe(k);
        if (lang === 'zh') expect(label, `${lang} ${k}`).toMatch(/[\u4e00-\u9fff]/);
        else expect(label, `${lang} ${k}`).not.toMatch(/[\u4e00-\u9fff]/);
      }
    }
    setLang('en');
  });

  test('label key helpers build the i18n keys', () => {
    expect(pointLabelKey('user:view')).toBe('roles.point.user:view');
    expect(moduleLabelKey('agent')).toBe('roles.module.agent');
    expect(dataScopeLabelKey('org_wide')).toBe('roles.scope.org_wide');
  });
});
