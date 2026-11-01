import '../helpers/setupEnv';

import { beforeEach, describe, expect, test, vi } from 'vitest';

// 在 import authService 之前替换它引用的 pool 为 testPool。
vi.mock('../../src/db/pool', async () => {
  const td = await import('../../src/db/testDb');
  return { pool: td.testPool };
});

import { authService } from '../../src/auth/authService';
import { LoginErrorCode } from '../../src/shared/enterpriseServerConstants';
import { resetSchema, runMigrations,testPool } from '../../src/db/testDb';

describe('auth/authService', () => {
  beforeEach(async () => {
    await resetSchema();
    await runMigrations();
    await testPool.query(`INSERT INTO orgs(id, name) VALUES ('o1', 'Test')`);
  });

  test('login 成功返回 JWT', async () => {
    await authService.createUser({ orgId: 'o1', username: 'alice', password: 'pw12345' });
    const { token, claims } = await authService.login('Test', 'alice', 'pw12345');
    expect(typeof claims.sub).toBe('string');
    expect(claims.roles).toContain('user');
    expect(token.length).toBeGreaterThan(20);
  });

  test('login 密码错误抛 LoginFailed(invalid_password)', async () => {
    await authService.createUser({ orgId: 'o1', username: 'alice', password: 'pw12345' });
    await expect(authService.login('Test', 'alice', 'wrong')).rejects.toMatchObject({
      code: LoginErrorCode.InvalidPassword,
    });
  });

  test('login 用户不存在抛 LoginFailed(user_not_found)', async () => {
    await authService.createUser({ orgId: 'o1', username: 'alice', password: 'pw12345' });
    await expect(authService.login('Test', 'nobody', 'pw12345')).rejects.toMatchObject({
      code: LoginErrorCode.UserNotFound,
    });
  });

  test('login 禁用账号抛 LoginFailed(user_disabled)', async () => {
    const u = await authService.createUser({ orgId: 'o1', username: 'bob', password: 'pw12345' });
    await authService.disable(u.id);
    await expect(authService.login('Test', 'bob', 'pw12345')).rejects.toMatchObject({
      code: LoginErrorCode.UserDisabled,
    });
  });

  test('login 未知组织抛 LoginFailed(org_not_found)', async () => {
    await authService.createUser({ orgId: 'o1', username: 'alice', password: 'pw12345' });
    await expect(authService.login('Nonexistent', 'alice', 'pw12345')).rejects.toMatchObject({
      code: LoginErrorCode.OrgNotFound,
    });
  });
});