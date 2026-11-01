import '../helpers/setupEnv';

import { afterEach, beforeEach, describe, expect, type MockInstance,test, vi } from 'vitest';

// One broken feed used to take the whole board down: every summary query runs
// in the same `Promise.all`, so a single `42703` from the activity feed
// answered 500 and the admin saw a dashboard with only the usage half. The
// route's own contract says a failure degrades a group, not the page — this
// file pins that one section's throw cannot blank the others.
vi.mock('../../src/db/pool', async () => {
  const td = await import('../../src/db/testDb');
  return { pool: td.testPool };
});
vi.mock('../../src/analytics/dashboard', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/analytics/dashboard')>();
  return {
    ...actual,
    queryActivities: async () => {
      throw new Error('feeds are down');
    },
  };
});

import { Hono } from 'hono';

import { signToken } from '../../src/auth/jwt';
import { resetSchema, runMigrations } from '../../src/db/testDb';
import { adminDashboardRoutes } from '../../src/routes/admin/dashboard';
import { agent, mcp, seedOrg, user } from '../helpers/dashboardSeed';

function app(): Hono {
  const a = new Hono();
  a.route('/', adminDashboardRoutes);
  return a;
}

const get = (path: string, token: string) =>
  app().request(path, { headers: { authorization: `Bearer ${token}` } });

describe('routes/admin/dashboard — 单段失败不拖垮整个面板', () => {
  // `ReturnType<typeof vi.spyOn>` picks the LAST overload, which is not the
  // console.error one; the type is spelled out to match `spyOn(console,
  // 'error')` exactly.
  let errorSpy: MockInstance<[message?: unknown, ...optionalParams: unknown[]], void>;

  beforeEach(async () => {
    await resetSchema();
    await runMigrations();
    await seedOrg();
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    errorSpy.mockRestore();
  });

  test('活动流查询抛错时 /summary 仍返回 200，其余段照常', async () => {
    await user('u1');
    await agent('a1', true);
    await mcp('c1');
    const token = await signToken({ sub: 'u1', orgId: 'o1', roles: ['super_admin'] });
    const res = await get('/admin/dashboard/summary', token);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      users: { total: number } | null;
      agents: { total: number } | null;
      mcp: { total: number } | null;
      health: { items: unknown[] } | null;
      activities: unknown;
    };
    expect(body.users).toEqual({ total: 1, enabled: 1, disabled: 0 });
    expect(body.agents).toEqual({ enabled: 1, total: 1 });
    expect(body.mcp!.total).toBe(1);
    expect(body.health).not.toBeNull();
    // 失真的那一段为空，而不是把别的段一起清空
    expect(body.activities).toBeNull();
  });

  test('失败的那一段记一条 error 日志，而不是无声吞掉', async () => {
    // A null section that nobody logs is a bug that never gets found; the
    // feed failing is evidence, not a normal state.
    await mcp('c1');
    const token = await signToken({ sub: 'u1', orgId: 'o1', roles: ['super_admin'] });
    await get('/admin/dashboard/summary', token);
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining('[Dashboard]'),
      expect.objectContaining({ section: 'activities' })
    );
  });
});
