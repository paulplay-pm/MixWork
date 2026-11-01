import '../helpers/setupEnv';

import { beforeEach, describe, expect, test, vi } from 'vitest';
vi.mock('../../src/db/pool', async () => {
  const td = await import('../../src/db/testDb');
  return { pool: td.testPool };
});

import {
  addAsrSeconds,
  DEFAULT_ASR_DAILY_LIMIT_SECONDS,
  getAsrQuota,
} from '../../src/asr/quota';
import { resetSchema, runMigrations, testPool } from '../../src/db/testDb';

async function seed(): Promise<void> {
  await testPool.query(`INSERT INTO orgs(id,name,timezone) VALUES ('o1','T','UTC')`);
  await testPool.query(
    `INSERT INTO users(id,org_id,username,password_hash,timezone)
     VALUES ('u1','o1','u1','x','UTC'), ('u2','o1','u2','x','Asia/Shanghai')`,
  );
}

describe('asr quota', () => {
  beforeEach(async () => {
    await resetSchema();
    await runMigrations();
    await seed();
  });

  test('无记录时 used=0、remaining=limit、limit 取默认值', async () => {
    const q = await getAsrQuota('o1', 'u1');
    expect(q.usedSecondsToday).toBe(0);
    expect(q.limitSecondsToday).toBe(DEFAULT_ASR_DAILY_LIMIT_SECONDS);
    expect(q.remainingSecondsToday).toBe(DEFAULT_ASR_DAILY_LIMIT_SECONDS);
  });

  test('provider config 的 limitSecondsToday 覆盖默认值', async () => {
    const q = await getAsrQuota('o1', 'u1', { limitSecondsToday: 120 });
    expect(q.limitSecondsToday).toBe(120);
  });

  test('addAsrSeconds 累加而不是覆盖', async () => {
    await addAsrSeconds('o1', 'u1', 30);
    await addAsrSeconds('o1', 'u1', 12);
    const q = await getAsrQuota('o1', 'u1');
    expect(q.usedSecondsToday).toBe(42);
    expect(q.remainingSecondsToday).toBe(DEFAULT_ASR_DAILY_LIMIT_SECONDS - 42);
  });

  test('remaining 不为负', async () => {
    await addAsrSeconds('o1', 'u1', DEFAULT_ASR_DAILY_LIMIT_SECONDS + 500);
    const q = await getAsrQuota('o1', 'u1');
    expect(q.remainingSecondsToday).toBe(0);
  });

  test('不同用户互不影响', async () => {
    await addAsrSeconds('o1', 'u1', 100);
    expect((await getAsrQuota('o1', 'u2')).usedSecondsToday).toBe(0);
  });

  test('日界按用户时区：同一时刻不同用户可能落在不同 day', async () => {
    // 2026-04-15T23:30Z 是上海 4/16 的上午。
    vi.setSystemTime(new Date('2026-04-15T23:30:00Z'));
    try {
      await addAsrSeconds('o1', 'u1', 60); // UTC 用户 → 2026-04-15
      await addAsrSeconds('o1', 'u2', 60); // 上海用户 → 2026-04-16
      const rows = await testPool.query<{ user_id: string; day: string }>(
        `SELECT user_id, day::text AS day FROM asr_daily_usage ORDER BY user_id`,
      );
      const byUser = Object.fromEntries(rows.rows.map((r) => [r.user_id, r.day]));
      expect(byUser.u1).toBe('2026-04-15');
      expect(byUser.u2).toBe('2026-04-16');
    } finally {
      vi.useRealTimers();
    }
  });

  test('零秒不写库', async () => {
    await addAsrSeconds('o1', 'u1', 0);
    const r = await testPool.query(`SELECT 1 FROM asr_daily_usage`);
    expect(r.rowCount).toBe(0);
  });
});
