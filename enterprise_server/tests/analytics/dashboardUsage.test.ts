import '../helpers/setupEnv';

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
vi.mock('../../src/db/pool', async () => {
  const td = await import('../../src/db/testDb');
  return { pool: td.testPool };
});
import { queryDashboardUsage } from '../../src/analytics/dashboard';
import { UsageRange } from '../../src/analytics/range';
import { resetSchema, runMigrations } from '../../src/db/testDb';
import {
  dept,
  providerKeyWithModel,
  seedOrg,
  usage,
  user,
} from '../helpers/dashboardSeed';

/** The window is resolved from the real clock, so every fixture is dated
 *  relative to a pinned "now" and the same instant drives both sides. */
const NOW = new Date('2026-04-15T09:30:00Z');

function atNow<T>(fn: () => Promise<T>): Promise<T> {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  const done = fn();
  return Promise.resolve(done).finally(() => vi.useRealTimers());
}

const H = (day: number, hour: number): string =>
  `2026-04-${String(day).padStart(2, '0')}T${String(hour).padStart(2, '0')}:00:00Z`;

describe('analytics/dashboard — 用量类聚合', () => {
  beforeEach(async () => {
    await resetSchema();
    await runMigrations();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  test('active 与 tokens 同时给出本期与上期', async () => {
    await seedOrg();
    await user('u1');
    await user('u2');
    await user('u3');
    await providerKeyWithModel('pk', 'm1');
    // 本期（近 7 天 = 04-09 起）：u1 三次、u2 一次
    await usage({ userId: 'u1', modelId: 'm1', tokens: 100, ts: H(10, 5) });
    await usage({ userId: 'u1', modelId: 'm1', tokens: 100, ts: H(11, 5) });
    await usage({ userId: 'u1', modelId: 'm1', tokens: 100, ts: H(12, 5) });
    await usage({ userId: 'u2', modelId: 'm1', tokens: 100, ts: H(13, 5) });
    // 上期（04-02…04-08）：只有 u1
    await usage({ userId: 'u1', modelId: 'm1', tokens: 200, ts: H(5, 5) });

    const r = await atNow(() => queryDashboardUsage({ orgId: 'o1', range: UsageRange.Last7Days }));
    expect(r.active).toEqual({ value: 2, prev: 1 });
    expect(r.tokens).toEqual({ value: 400, prev: 200 });
    expect(r.range).toBe('7d');
  });

  test('trend 的 granularity：today 为 hour，其余为 day', async () => {
    await seedOrg();
    await user('u1');
    await providerKeyWithModel('pk', 'm1');
    await usage({ userId: 'u1', modelId: 'm1', tokens: 10, ts: H(15, 3) });

    const today = await atNow(() =>
      queryDashboardUsage({ orgId: 'o1', range: UsageRange.Today })
    );
    expect(today.trend.granularity).toBe('hour');
    // 09:30 → 00…09 共 10 个整点
    expect(today.trend.points).toHaveLength(10);
    expect(today.trend.points[0].label).toBe('00:00');
    expect(today.trend.points.at(-1)!.label).toBe('09:00');

    const week = await atNow(() =>
      queryDashboardUsage({ orgId: 'o1', range: UsageRange.Last7Days })
    );
    expect(week.trend.granularity).toBe('day');
    expect(week.trend.points).toHaveLength(7);
  });

  test('trend 补齐零值日：没有调用的日子仍返回一个 point', async () => {
    await seedOrg();
    await user('u1');
    await providerKeyWithModel('pk', 'm1');
    await usage({ userId: 'u1', modelId: 'm1', tokens: 50, ts: H(9, 5) });
    await usage({ userId: 'u1', modelId: 'm1', tokens: 70, ts: H(13, 5) });

    const r = await atNow(() => queryDashboardUsage({ orgId: 'o1', range: UsageRange.Last7Days }));
    expect(r.trend.points).toHaveLength(7);
    const byKey = Object.fromEntries(r.trend.points.map((p) => [p.key, p]));
    expect(byKey['2026-04-09'].tokens).toBe(50);
    expect(byKey['2026-04-10'].tokens).toBe(0);
    expect(byKey['2026-04-10'].calls).toBe(0);
    expect(byKey['2026-04-13'].tokens).toBe(70);
  });

  test('trend 的 day 标签是 MM-DD', async () => {
    await seedOrg();
    await user('u1');
    await providerKeyWithModel('pk', 'm1');
    await usage({ userId: 'u1', modelId: 'm1', tokens: 5, ts: H(15, 5) });
    const r = await atNow(() => queryDashboardUsage({ orgId: 'o1', range: UsageRange.Last7Days }));
    expect(r.trend.points[0].label).toBe('04/09');
  });

  test('modelTop 只含有调用的模型，按 tokens 降序', async () => {
    await seedOrg();
    await user('u1');
    await providerKeyWithModel('pk', 'm_small', { model: 'small' });
    await providerKeyWithModel('pk2', 'm_big', { model: 'big', provider: 'bigp' });
    await providerKeyWithModel('pk3', 'm_idle', { model: 'idle', provider: 'idlep' });
    await usage({ userId: 'u1', modelId: 'm_small', tokens: 10, ts: H(10, 5) });
    await usage({ userId: 'u1', modelId: 'm_big', tokens: 90, ts: H(10, 5) });

    const r = await atNow(() => queryDashboardUsage({ orgId: 'o1', range: UsageRange.Last7Days }));
    expect(r.modelTop.map((m) => m.model)).toEqual(['big', 'small']);
    expect(r.modelTop[0].tokens).toBe(90);
  });

  test('modelTop 把同 provider+model 的多次调用合并求和', async () => {
    await seedOrg();
    await user('u1');
    await providerKeyWithModel('pk', 'm1', { model: 'same' });
    await usage({ userId: 'u1', modelId: 'm1', tokens: 10, ts: H(10, 5) });
    await usage({ userId: 'u1', modelId: 'm1', tokens: 20, ts: H(11, 5) });
    await usage({ userId: 'u1', modelId: 'm1', tokens: 30, ts: H(12, 5) });

    const r = await atNow(() => queryDashboardUsage({ orgId: 'o1', range: UsageRange.Last7Days }));
    expect(r.modelTop).toHaveLength(1);
    expect(r.modelTop[0].tokens).toBe(60);
    expect(r.modelTop[0].calls).toBe(3);
  });

  test('modelTop 的 limit 截断', async () => {
    await seedOrg();
    await user('u1');
    for (let i = 0; i < 8; i++) {
      await providerKeyWithModel(`pk${i}`, `m${i}`, { model: `m${i}`, provider: `p${i}` });
      await usage({ userId: 'u1', modelId: `m${i}`, tokens: (i + 1) * 10, ts: H(10, 5) });
    }
    const r = await atNow(() =>
      queryDashboardUsage({ orgId: 'o1', range: UsageRange.Last7Days, limit: 3 })
    );
    expect(r.modelTop.map((m) => m.model)).toEqual(['m7', 'm6', 'm5']);
  });

  test('deptTop 把子部门上卷到一级部门', async () => {
    await seedOrg();
    await dept('d1', '产品部', null);
    await dept('d2', '平台组', 'd1');
    await user('u1', { deptId: 'd1' });
    await user('u2', { deptId: 'd2' });
    await providerKeyWithModel('pk', 'm1');
    await usage({ userId: 'u1', modelId: 'm1', tokens: 100, ts: H(10, 5) });
    await usage({ userId: 'u2', modelId: 'm1', tokens: 250, ts: H(10, 5) });

    const r = await atNow(() => queryDashboardUsage({ orgId: 'o1', range: UsageRange.Last7Days }));
    expect(r.deptTop).toHaveLength(1);
    expect(r.deptTop[0].departmentId).toBe('d1');
    expect(r.deptTop[0].name).toBe('产品部');
    expect(r.deptTop[0].users).toBe(2);
    expect(r.deptTop[0].tokens).toBe(350);
  });

  test('deptTop 的未分配桶返回 departmentId:null 与 name:null（前端渲染 i18n 文案）', async () => {
    await seedOrg();
    await dept('d1', '产品部', null);
    await user('u1', { deptId: 'd1' });
    await user('u9');
    await providerKeyWithModel('pk', 'm1');
    await usage({ userId: 'u1', modelId: 'm1', tokens: 100, ts: H(10, 5) });
    await usage({ userId: 'u9', modelId: 'm1', tokens: 40, ts: H(10, 5) });

    const r = await atNow(() => queryDashboardUsage({ orgId: 'o1', range: UsageRange.Last7Days }));
    const unassigned = r.deptTop.find((d) => d.departmentId === null)!;
    expect(unassigned).toBeDefined();
    expect(unassigned.name).toBeNull();
    expect(unassigned.users).toBe(1);
    expect(unassigned.tokens).toBe(40);
  });

  test('deptTop 按 tokens 降序并尊重 limit', async () => {
    await seedOrg();
    await providerKeyWithModel('pk', 'm1');
    for (let i = 1; i <= 4; i++) {
      await dept(`d${i}`, `部门${i}`, null);
      await user(`u${i}`, { deptId: `d${i}` });
      await usage({ userId: `u${i}`, modelId: 'm1', tokens: i * 10, ts: H(10, 5) });
    }
    const r = await atNow(() =>
      queryDashboardUsage({ orgId: 'o1', range: UsageRange.Last7Days, limit: 2 })
    );
    expect(r.deptTop.map((d) => d.name)).toEqual(['部门4', '部门3']);
  });

  test('unaccountedCalls 统计 usage_missing 的行数', async () => {
    await seedOrg();
    await user('u1');
    await providerKeyWithModel('pk', 'm1');
    await usage({ userId: 'u1', modelId: 'm1', tokens: 10, ts: H(10, 5) });
    await usage({ userId: 'u1', modelId: 'm1', tokens: 10, ts: H(11, 5), missing: true });
    await usage({ userId: 'u1', modelId: 'm1', tokens: 10, ts: H(12, 5), missing: true });
    const r = await atNow(() => queryDashboardUsage({ orgId: 'o1', range: UsageRange.Last7Days }));
    expect(r.unaccountedCalls).toBe(2);
  });

  test('SUM 走 bigint，累加超过 INTEGER 上限也不溢出', async () => {
    await seedOrg();
    await user('u1');
    await providerKeyWithModel('pk', 'm1');
    // 2_000_000_000 两行相加 = 4e9，超过 INTEGER 上限 2_147_483_647。
    await usage({ userId: 'u1', modelId: 'm1', tokens: 2_000_000_000, ts: H(10, 5) });
    await usage({ userId: 'u1', modelId: 'm1', tokens: 2_000_000_000, ts: H(11, 5) });
    const r = await atNow(() => queryDashboardUsage({ orgId: 'o1', range: UsageRange.Last7Days }));
    expect(r.tokens.value).toBe(4_000_000_000);
    expect(r.tokens.value).toBeGreaterThan(0);
  });

  test('范围内无任何调用时 modelTop 与 deptTop 为空数组而不是报错', async () => {
    await seedOrg();
    await user('u1');
    await providerKeyWithModel('pk', 'm1');
    const r = await atNow(() => queryDashboardUsage({ orgId: 'o1', range: UsageRange.Last7Days }));
    expect(r.modelTop).toEqual([]);
    expect(r.deptTop).toEqual([]);
    expect(r.active.value).toBe(0);
    expect(r.tokens.value).toBe(0);
  });
});