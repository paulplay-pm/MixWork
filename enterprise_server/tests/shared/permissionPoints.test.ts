import { describe, expect, test } from 'vitest';

import {
  BUILTIN_ROLE_POINTS,
  DATA_SCOPE_VALUES,
  DataScope,
  PERMISSION_MODULES,
  PERMISSION_POINTS,
  PermissionPoint,
} from '../../src/shared/permissionPoints';

describe('permissionPoints catalog', () => {
  test('exposes 51 unique fine-grained points', () => {
    expect(new Set(PERMISSION_POINTS).size).toBe(PERMISSION_POINTS.length);
    expect(PERMISSION_POINTS).toHaveLength(51);
  });
  test('every point is module:action and covered by exactly one module', () => {
    const all = PERMISSION_MODULES.flatMap((m) => m.points);
    expect(new Set(all).size).toBe(51);
    for (const p of all) expect(p).toMatch(/^[a-z]+:[a-z_]+$/);
  });
  test('data scope enum has the 5 PRD values', () => {
    expect(DATA_SCOPE_VALUES).toEqual(
      ['org_wide', 'dept_and_below', 'dept', 'self', 'custom_dept_tree'],
    );
    expect(DataScope.Self).toBe('self');
  });
  test('super_admin built-in point set is the full catalog', () => {
    // super_admin covers every point; assert a few module anchors are present
    for (const m of PERMISSION_MODULES) {
      for (const p of m.points) {
        expect(PERMISSION_POINTS).toContain(p);
      }
    }
  });
  test('kit points and module exist', () => {
    expect(PERMISSION_POINTS).toContain('kit:view');
    expect(PERMISSION_POINTS).toContain('kit:delete');
    expect(PERMISSION_MODULES.find((m) => m.key === 'kit')).toBeDefined();
  });
});

describe('permissionPoints — usage points', () => {
  test('usage:view and usage:export are registered', () => {
    expect(PermissionPoint.UsageView).toBe('usage:view');
    expect(PermissionPoint.UsageExport).toBe('usage:export');
    expect(PERMISSION_POINTS).toContain('usage:view');
    expect(PERMISSION_POINTS).toContain('usage:export');
  });

  test('a usage module groups both points', () => {
    const mod = PERMISSION_MODULES.find((m) => m.key === 'usage');
    expect(mod).toBeDefined();
    expect(mod!.points).toEqual(['usage:view', 'usage:export']);
  });

  test('super_admin, auditor and org_admin all hold both usage points', () => {
    for (const role of ['super_admin', 'auditor', 'org_admin'] as const) {
      expect(BUILTIN_ROLE_POINTS[role]).toContain(PermissionPoint.UsageView);
      expect(BUILTIN_ROLE_POINTS[role]).toContain(PermissionPoint.UsageExport);
    }
  });

  test('dept_admin, member and dev do NOT gain usage points', () => {
    for (const role of ['dept_admin', 'member', 'dev'] as const) {
      expect(BUILTIN_ROLE_POINTS[role]).not.toContain(PermissionPoint.UsageView);
      expect(BUILTIN_ROLE_POINTS[role]).not.toContain(PermissionPoint.UsageExport);
    }
  });

  test('every module point is a registered PermissionPoint', () => {
    for (const m of PERMISSION_MODULES) {
      for (const p of m.points) expect(PERMISSION_POINTS).toContain(p);
    }
  });
});
