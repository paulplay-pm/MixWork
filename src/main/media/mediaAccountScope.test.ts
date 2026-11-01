import { describe, expect, test } from 'vitest';

import { resolveMediaAccountOwnerKey } from './mediaAccountScope';

const ENTERPRISE_SESSION = {
  orgId: '万象服务',
  userId: '1e5ee1f5-6b94-4fc2-96ce-a8b2033bd678',
};

describe('resolveMediaAccountOwnerKey', () => {
  /**
   * The regression.
   *
   * The multi-tenant enterprise deployment has no `auth_user` profile — that
   * key is only written by the legacy youdao login, which the enterprise
   * deployment never runs. Keying the media account scope on that profile
   * alone therefore produced NO scope for every enterprise user, so the media
   * tool answered "this session is not bound to a signed-in account" and the
   * model picker listed no media models at all.
   */
  test('企业会话（没有 auth_user）也能解析出账号作用域', () => {
    expect(resolveMediaAccountOwnerKey({
      legacyUser: null,
      legacyEnterpriseId: null,
      enterpriseSession: ENTERPRISE_SESSION,
    })).toBe('enterprise:1e5ee1f5-6b94-4fc2-96ce-a8b2033bd678:万象服务');
  });

  test('账号作用域按 org 区分：同一个人在不同 org 里不是同一个作用域', () => {
    const other = resolveMediaAccountOwnerKey({
      legacyUser: null,
      legacyEnterpriseId: null,
      enterpriseSession: { ...ENTERPRISE_SESSION, orgId: '另一个组织' },
    });
    expect(other).not.toBe(
      resolveMediaAccountOwnerKey({
        legacyUser: null,
        legacyEnterpriseId: null,
        enterpriseSession: ENTERPRISE_SESSION,
      }),
    );
  });

  test('没有企业会话时无法解析（未登录不能拿到作用域）', () => {
    expect(resolveMediaAccountOwnerKey({
      legacyUser: null,
      legacyEnterpriseId: null,
      enterpriseSession: null,
    })).toBeNull();
  });

  test('企业会话缺 org 或 user 时失败关闭', () => {
    expect(resolveMediaAccountOwnerKey({
      legacyUser: null,
      legacyEnterpriseId: null,
      enterpriseSession: { orgId: '', userId: ENTERPRISE_SESSION.userId },
    })).toBeNull();
    expect(resolveMediaAccountOwnerKey({
      legacyUser: null,
      legacyEnterpriseId: null,
      enterpriseSession: { orgId: ENTERPRISE_SESSION.orgId, userId: '' },
    })).toBeNull();
  });

  /**
   * The legacy youdao account systems keep working: the consumer profile and
   * the legacy enterprise context (numeric enterprise id) still decide the
   * key when they are present.
   */
  test('遗留的消费者账号仍然按 auth_user 解析', () => {
    expect(resolveMediaAccountOwnerKey({
      legacyUser: { userId: '6', yid: 'employee' },
      legacyEnterpriseId: null,
      enterpriseSession: null,
    })).toBe('personal:6');
  });

  test('遗留的企业账号仍然按 account context 解析', () => {
    expect(resolveMediaAccountOwnerKey({
      legacyUser: { userId: '6' },
      legacyEnterpriseId: 1001,
      enterpriseSession: null,
    })).toBe('enterprise:6:1001');
  });

  test('遗留账号优先于企业会话（两套账号系统不同时在线）', () => {
    expect(resolveMediaAccountOwnerKey({
      legacyUser: { userId: '6' },
      legacyEnterpriseId: null,
      enterpriseSession: ENTERPRISE_SESSION,
    })).toBe('personal:6');
  });

  /**
   * A legacy enterprise profile whose account context was lost must NOT
   * silently fall back to an unscoped key: `createAccountOwnerKey` fails
   * closed for that case, and the enterprise session is a different account
   * system, so the result stays null.
   */
  test('遗留企业账号缺 account context 时失败关闭', () => {
    expect(resolveMediaAccountOwnerKey({
      legacyUser: { userId: '6', accountMode: 'enterprise' },
      legacyEnterpriseId: null,
      enterpriseSession: null,
    })).toBeNull();
  });
});
