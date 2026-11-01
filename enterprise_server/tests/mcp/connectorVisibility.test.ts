import { describe, expect, test } from 'vitest';

import { connectorVisibleToCaller } from '../../src/mcp/connectorVisibility';

const paths = new Map([
  ['d1', 'd1'],
  ['d2', 'd1/d2'],
  ['d9', 'd9'],
]);
const caller = { userId: 'u1', isSuperAdmin: false, deptIds: ['d2'] };
const scope = (s: { allCompany?: boolean; deptIds?: string[]; userIds?: string[] }) => ({
  scope: { allCompany: !!s.allCompany, deptIds: s.deptIds ?? [], userIds: s.userIds ?? [] },
});

describe('connectorVisibleToCaller', () => {
  test('granting a parent dept reaches the child dept member', () => {
    expect(connectorVisibleToCaller(scope({ deptIds: ['d1'] }), caller, paths)).toBe(true);
  });

  test('another dept does not', () => {
    expect(connectorVisibleToCaller(scope({ deptIds: ['d9'] }), caller, paths)).toBe(false);
  });

  test('a user exception and allCompany both grant', () => {
    expect(connectorVisibleToCaller(scope({ userIds: ['u1'] }), caller, paths)).toBe(true);
    expect(connectorVisibleToCaller(scope({ allCompany: true }), caller, paths)).toBe(true);
  });

  test('an empty scope grants nobody', () => {
    expect(connectorVisibleToCaller(scope({}), caller, paths)).toBe(false);
  });

  test('a super admin sees everything', () => {
    expect(
      connectorVisibleToCaller(scope({ deptIds: ['d9'] }), { ...caller, isSuperAdmin: true }, paths),
    ).toBe(true);
  });
});
