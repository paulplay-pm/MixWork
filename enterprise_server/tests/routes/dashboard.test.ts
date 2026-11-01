import '../helpers/setupEnv';

import { beforeEach, describe, expect, test, vi } from 'vitest';
vi.mock('../../src/db/pool', async () => {
  const td = await import('../../src/db/testDb');
  return { pool: td.testPool };
});
import { Hono } from 'hono';

import { signToken } from '../../src/auth/jwt';
import { resetSchema, runMigrations, testPool } from '../../src/db/testDb';
import { roleService } from '../../src/org/roleService';
import { adminDashboardRoutes } from '../../src/routes/admin/dashboard';
import { PermissionPoint } from '../../src/shared/permissionPoints';
import { agent, mcp, seedOrg, user } from '../helpers/dashboardSeed';

/** A role carrying exactly the points named, so each assertion is about the
 *  trimming and not about whatever the seeded roles happen to grant.
 *
 *  The code is sanitised because role codes are `^[a-z0-9_]+$` and permission
 *  points contain a colon. */
async function roleWith(points: PermissionPoint[]): Promise<string> {
  const name = `r${points.join('_').replace(/[^a-z0-9]+/g, '_')}`;
  await roleService.create({ name, permissions: points });
  return name;
}

/** The summary wire shape, as the route returns it (snake_case). */
interface SummaryBody {
  updated_at: string;
  users: { total: number; enabled: number; disabled: number } | null;
  agents: { enabled: number; total: number } | null;
  mcp: {
    enabled: number;
    total: number;
    abnormal: number;
    first_abnormal: string | null;
  } | null;
  health: {
    checked_at: string;
    items: Array<{
      id: string;
      type: string;
      status: string;
      name_zh: string;
      name_en: string;
      latency_ms: number | null;
      last_test_at: string | null;
    }>;
  } | null;
  activities: Array<{
    id: string;
    ts: string;
    action: string;
    action_zh: string;
    action_en: string;
    tone: string;
    target_type: string;
    target_name_zh: string | null;
    target_name_en: string | null;
    user_id: string | null;
    user_name: string | null;
  }> | null;
}

/** The usage wire shape. */
interface UsageBody {
  range: string;
  from: string;
  to: string;
  timezone: string;
  active: number;
  tokens: number;
  unaccounted_calls: number;
  trend: { granularity: string; points: unknown[] };
  model_top: Array<{
    provider: string;
    model: string;
    display_name: string;
    tokens: number;
    calls: number;
  }>;
  dept_top: Array<{
    department_id: string;
    name: string;
    users: number;
    tokens: number;
  }>;
}

/** `Response.json()` is `unknown`; the tests read specific shapes. */
const summary = async (res: Response): Promise<SummaryBody> =>
  (await res.json()) as SummaryBody;
const usage = async (res: Response): Promise<UsageBody> => (await res.json()) as UsageBody;

function app(): Hono {
  const a = new Hono();
  a.route('/', adminDashboardRoutes);
  return a;
}

const get = (path: string, token: string) =>
  app().request(path, { headers: { authorization: `Bearer ${token}` } });

describe('routes/admin/dashboard', () => {
  beforeEach(async () => {
    await resetSchema();
    await runMigrations();
    await seedOrg();
  });

  test('401 未登录', async () => {
    expect((await app().request('/admin/dashboard/summary')).status).toBe(401);
  });

  test('无 usage:view 时 /usage 返回 403', async () => {
    const token = await signToken({
      sub: 'u1',
      orgId: 'o1',
      roles: [await roleWith([PermissionPoint.UserView])],
    });
    expect((await get('/admin/dashboard/usage?range=7d', token)).status).toBe(403);
  });

  test('无 usage:view 时 /summary 仍返回配置段', async () => {
    await user('u1');
    await agent('a1', true);
    await mcp('c1');
    const token = await signToken({
      sub: 'u1',
      orgId: 'o1',
      roles: [await roleWith([PermissionPoint.UserView, PermissionPoint.AgentView, PermissionPoint.McpView])],
    });
    const res = await get('/admin/dashboard/summary', token);
    expect(res.status).toBe(200);
    const body = await summary(res);
    expect(body.users).toEqual({ total: 1, enabled: 1, disabled: 0 });
    expect(body.agents).toEqual({ enabled: 1, total: 1 });
    expect(body.mcp!.enabled).toBe(1);
  });

  test('缺 user:view 时 users 为 null，其余段照常', async () => {
    await agent('a1', true);
    const token = await signToken({
      sub: 'u1',
      orgId: 'o1',
      roles: [await roleWith([PermissionPoint.AgentView])],
    });
    const body = await summary(await get('/admin/dashboard/summary', token));
    expect(body.users).toBeNull();
    expect(body.agents).not.toBeNull();
  });

  test('缺 mcp:view 时 mcp 与 health 均为 null', async () => {
    const token = await signToken({
      sub: 'u1',
      orgId: 'o1',
      roles: [await roleWith([PermissionPoint.AgentView])],
    });
    const body = await summary(await get('/admin/dashboard/summary', token));
    expect(body.mcp).toBeNull();
    expect(body.health).toBeNull();
  });

  test('有 mcp:view 但无 provider:view 时，health 只含 MCP 条目', async () => {
    await mcp('c1', { en: 'KB', status: 'connected', latency: 10, testedAt: '2026-04-15T01:00:00Z' });
    await testPool.query(
      `INSERT INTO provider_keys(id, org_id, provider, endpoint, label, status, latency_ms, last_test_at)
       VALUES ('p1','o1','openai','https://x','OpenAI','connected',10,'2026-04-15T09:00:00Z')`
    );
    const token = await signToken({
      sub: 'u1',
      orgId: 'o1',
      roles: [await roleWith([PermissionPoint.McpView])],
    });
    const body = await summary(await get('/admin/dashboard/summary', token));
    // The wire field is `type`, per the snake_case mapping in the route.
    expect(body.health!.items.every((i) => i.type === 'mcp')).toBe(true);
    // 模型侧那次更晚的检测不能通过时间戳泄漏
    expect(body.health!.checked_at).toBe('2026-04-15T01:00:00.000Z');
  });

  test('缺 audit:view 时 activities 为 null', async () => {
    const token = await signToken({
      sub: 'u1',
      orgId: 'o1',
      roles: [await roleWith([PermissionPoint.AgentView])],
    });
    const body = await summary(await get('/admin/dashboard/summary', token));
    expect(body.activities).toBeNull();
  });

  test('super_admin 全段可见', async () => {
    await user('u1');
    await agent('a1', true);
    await mcp('c1');
    const token = await signToken({ sub: 'u1', orgId: 'o1', roles: ['super_admin'] });
    const body = await summary(await get('/admin/dashboard/summary', token));
    expect(body.users).not.toBeNull();
    expect(body.agents).not.toBeNull();
    expect(body.mcp).not.toBeNull();
    expect(body.health).not.toBeNull();
    expect(Array.isArray(body.activities)).toBe(true);
  });

  test('summary 的线格式是 snake_case', async () => {
    await mcp('c1', { en: 'CRM', status: 'failed', testedAt: '2026-04-15T01:00:00Z' });
    const token = await signToken({ sub: 'u1', orgId: 'o1', roles: ['super_admin'] });
    const body = await summary(await get('/admin/dashboard/summary', token));
    expect(body.health).toHaveProperty('checked_at');
    expect(body.health!.items[0]).toHaveProperty('last_test_at');
    expect(body.health!.items[0]).toHaveProperty('latency_ms');
    expect(body.health!.items[0]).toHaveProperty('name_zh');
    expect(body.health!.items[0]).not.toHaveProperty('checkedAt');
  });

  test('usage 的线格式是 snake_case', async () => {
    const token = await signToken({ sub: 'u1', orgId: 'o1', roles: ['super_admin'] });
    const body = await usage(await get('/admin/dashboard/usage?range=7d', token));
    expect(body).toHaveProperty('unaccounted_calls');
    expect(body).toHaveProperty('model_top');
    expect(body).toHaveProperty('dept_top');
    expect(body.trend).toHaveProperty('granularity');
    expect(body).not.toHaveProperty('unaccountedCalls');
  });

  test('orgId 查询参数被忽略：换一个 orgId 不改变返回数据', async () => {
    await testPool.query(`INSERT INTO orgs(id, name, timezone) VALUES ('o2','Other','UTC')`);
    // Seeded into o2 explicitly: `user()` from the shared helper always writes
    // o1, which would make this pass for the wrong reason.
    await testPool.query(
      `INSERT INTO users(id, org_id, username, password_hash) VALUES ('other1','o2','other1','x')`
    );
    const token = await signToken({ sub: 'u1', orgId: 'o1', roles: ['super_admin'] });
    const body = await summary(await get('/admin/dashboard/summary?orgId=o2', token));
    // o2 has a user; o1 does not. Reading the query param would return 1.
    expect(body.users!.total).toBe(0);
  });

  test('usage 的非法 range 返回 400', async () => {
    const token = await signToken({ sub: 'u1', orgId: 'o1', roles: ['super_admin'] });
    expect((await get('/admin/dashboard/usage?range=nope', token)).status).toBe(400);
  });

  test('usage 缺省 range 时按近 7 天处理', async () => {
    const token = await signToken({ sub: 'u1', orgId: 'o1', roles: ['super_admin'] });
    const res = await get('/admin/dashboard/usage', token);
    expect(res.status).toBe(200);
    expect((await usage(res)).range).toBe('7d');
  });
});