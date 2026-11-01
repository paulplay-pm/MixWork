import { expect, test } from 'vitest';

import {
  DATA_SCOPE_VALUES as SERVER_DATA_SCOPE_VALUES,
  PERMISSION_MODULES as SERVER_PERMISSION_MODULES,
  PERMISSION_POINTS as SERVER_PERMISSION_POINTS,
} from '../../../src/shared/permissionPoints';
import { DATA_SCOPE_VALUES, PERMISSION_MODULES, PERMISSION_POINTS } from '../../src/shared/permissions';

/**
 * `src/shared/permissions.ts` is a hand-kept mirror of the server catalog
 * (the SPA does not ship the server's src/ at runtime). Importing the server
 * module directly here means any point or module added, removed or reordered
 * server-side fails these tests until the mirror is brought back in step —
 * in BOTH directions, which is the direction that previously drifted twice
 * (kit and sso were missed).
 */

test('SPA point codes match the server catalog', () => {
  expect([...PERMISSION_POINTS].sort()).toEqual([...SERVER_PERMISSION_POINTS].sort());
});

test('SPA module keys and their grouping match the server catalog, in order', () => {
  expect(PERMISSION_MODULES.map((m) => m.key)).toEqual(SERVER_PERMISSION_MODULES.map((m) => m.key));
  expect(PERMISSION_MODULES.map((m) => m.points)).toEqual(SERVER_PERMISSION_MODULES.map((m) => m.points));
  // Orphan-point invariant, checked against the server catalog directly so it
  // holds even if a point is stranded in both mirrors at once: every point must
  // belong to exactly one module. PermissionGroupTree's "select all" grants
  // [...PERMISSION_POINTS] rather than the union of PERMISSION_MODULES, so a
  // point outside every module is granted by select-all while never rendering
  // in the picker.
  expect(
    SERVER_PERMISSION_MODULES.flatMap((m) => m.points),
    'server catalog: every point must belong to exactly one module',
  ).toEqual(SERVER_PERMISSION_POINTS);
});

test('SPA data scope values match the server catalog', () => {
  expect(DATA_SCOPE_VALUES).toEqual(SERVER_DATA_SCOPE_VALUES);
});

test('usage points are present in both the server catalog and the SPA mirror', () => {
  for (const catalog of [SERVER_PERMISSION_POINTS, PERMISSION_POINTS]) {
    expect(catalog).toContain('usage:view');
    expect(catalog).toContain('usage:export');
  }
  const serverUsage = SERVER_PERMISSION_MODULES.find((m) => m.key === 'usage');
  const spaUsage = PERMISSION_MODULES.find((m) => m.key === 'usage');
  expect(serverUsage).toBeDefined();
  expect(spaUsage).toBeDefined();
  expect(spaUsage!.points).toEqual(['usage:view', 'usage:export']);
  expect(spaUsage!.points).toEqual(serverUsage!.points);
});
