import '../helpers/setupEnv';

import { beforeEach, describe, expect, test, vi } from 'vitest';
vi.mock('../../src/db/pool', async () => {
  const td = await import('../../src/db/testDb');
  return { pool: td.testPool };
});
import { resolvePreviousUsageRange, resolveUsageRange, UsageRange } from '../../src/analytics/range';
import { resetSchema, runMigrations, testPool } from '../../src/db/testDb';

/** A fixed "now" so every window in this file is deterministic. 2026-04-15 is a
 *  Wednesday; the month ranges below depend on it being mid-month, because a
 *  test run on the 1st would silently measure a different thing. */
const NOW = new Date('2026-04-15T09:30:00Z');

async function seedOrg(timezone: string): Promise<string> {
  await testPool.query(`INSERT INTO orgs(id, name, timezone) VALUES ('o1','T',$1)`, [timezone]);
  return 'o1';
}

/** Run `fn` with the clock pinned to NOW. Resolves the previous window under
 *  the same conditions the production route would. */
async function atNow<T>(fn: () => Promise<T>): Promise<T> {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  try {
    return await fn();
  } finally {
    vi.useRealTimers();
  }
}

function prev(range: typeof UsageRange[keyof typeof UsageRange]) {
  return atNow(() => resolvePreviousUsageRange('o1', range));
}

describe('analytics/resolvePreviousUsageRange', () => {
  beforeEach(async () => {
    await resetSchema();
    await runMigrations();
  });

  test('7d 的上期是紧邻的等长 7 天', async () => {
    await seedOrg('UTC');
    // 本期 = 04-09 … 04-15（7 天），上期 = 04-02 … 04-08。
    const r = await prev(UsageRange.Last7Days);
    expect(r.days).toHaveLength(7);
    expect(r.days[0]).toBe('2026-04-02');
    expect(r.days.at(-1)).toBe('2026-04-08');
  });

  test('30d 的上期是紧邻的等长 30 天', async () => {
    await seedOrg('UTC');
    // 本期 = 03-17 … 04-15，上期 = 02-15 … 03-16。
    const r = await prev(UsageRange.Last30Days);
    expect(r.days).toHaveLength(30);
    expect(r.days[0]).toBe('2026-02-15');
    expect(r.days.at(-1)).toBe('2026-03-16');
  });

  test('last_month(3 月, 31 天) 的上期是 2 月，而不是等长规则算出的 1/29–2/28', async () => {
    // 这条是本模块存在的理由：等长回退 [3/1 − 31, 3/1) 落在 1/29–2/28，
    // 跨了两个月，"上月 → 上上月"的环比就变成"跨月环比"。
    await seedOrg('UTC');
    const r = await prev(UsageRange.LastMonth);
    expect(r.days[0]).toBe('2026-02-01');
    expect(r.days.at(-1)).toBe('2026-02-28');
    expect(r.days).toHaveLength(28); // 2026 非闰年
  });

  test('this_month 的上期是完整的上一个月', async () => {
    // boundsFor(ThisMonth) 返回 [4/1, 5/1)，即整月而非已过天数 —— 用量页既有
    // 行为，面板必须与之一致（未来几天没有数据行，不影响聚合）。4 月 30 天，
    // 所以 L = 30，上期是 3/1–3/30（与 4/1–4/30 逐日对齐，即"上月同期"）。
    await seedOrg('UTC');
    const r = await prev(UsageRange.ThisMonth);
    expect(r.days[0]).toBe('2026-03-01');
    expect(r.days.at(-1)).toBe('2026-03-30');
    expect(r.days).toHaveLength(30);
  });

  test('today 的上期右界截断到当前墙钟时刻', async () => {
    await seedOrg('UTC');
    const r = await prev(UsageRange.Today);
    expect(r.days).toEqual(['2026-04-14']);
    expect(r.to.getUTCHours()).toBe(9);
    expect(r.to.getUTCMinutes()).toBe(30);
    expect(r.to.getTime()).toBeLessThan(NOW.getTime());
  });

  test('非 UTC 组织时，today 的上期右界按组织时区截断', async () => {
    // Asia/Shanghai = UTC+8，NOW 是当地 17:30。上期右界必须是「昨天同一墙钟
    // 时刻」= 当地 04-14 17:30，也就是 04-14T09:30Z —— 比 NOW 早一整天。
    // 断言用「距上期起点的时长」而不是绝对时刻：17.5h 只有在按组织时区取
    // 小时数时才成立，按 UTC 取会得到 9.5h，正是这条要挡的错误。
    await seedOrg('Asia/Shanghai');
    const r = await prev(UsageRange.Today);
    expect(r.days).toEqual(['2026-04-14']);
    expect(r.to.getTime() - r.from.getTime()).toBe((17 * 60 + 30) * 60000);
  });

  test('本期窗口的 to 不被截断，与用量页一致', async () => {
    await seedOrg('UTC');
    const cur = await atNow(() => resolveUsageRange('o1', UsageRange.Today));
    expect(cur.to.getTime()).toBe(new Date('2026-04-16T00:00:00Z').getTime());
  });

  test('未知范围抛错', async () => {
    await seedOrg('UTC');
    await expect(prev('nope' as never)).rejects.toThrow(/unknown usage range/);
  });
});