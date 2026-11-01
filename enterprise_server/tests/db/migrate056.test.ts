import '../helpers/setupEnv';

import { beforeEach, describe, expect, test } from 'vitest';

import { resetSchema, runMigrations, testPool } from '../../src/db/testDb';

const MIGRATION_056 = '056_media_tasks_submitting_status.sql';

async function seedTask(status: string): Promise<void> {
  await testPool.query(`INSERT INTO orgs(id,name) VALUES ('o1','T') ON CONFLICT DO NOTHING`);
  await testPool.query(
    `INSERT INTO users(id,org_id,username,password_hash) VALUES ('u1','o1','u1','x') ON CONFLICT DO NOTHING`,
  );
  await testPool.query(
    `INSERT INTO media_tasks(id,org_id,user_id,kind,model,prompt,status)
     VALUES ('t1','o1','u1','image','m','{}'::jsonb,$1)`,
    [status],
  );
}

describe('db/migrate 056 (media_tasks.status = submitting)', () => {
  beforeEach(async () => {
    await resetSchema();
  });

  test('media_tasks 接受 submitting 状态', async () => {
    await runMigrations();
    await seedTask('submitting');
    const r = await testPool.query<{ status: string }>(
      `SELECT status FROM media_tasks WHERE id = 't1'`,
    );
    expect(r.rows[0].status).toBe('submitting');
  });

  /**
   * The state that matters is not "a fresh database" but "a database that
   * already applied 054" — 054 created the table with a CHECK on `status`, and
   * the ledger keys on the file NAME, so editing 054 would change nothing on
   * any deployed database.
   */
  test('已应用 054/055 的旧库，写 submitting 会被 CHECK 拒掉', async () => {
    await runMigrations({ exclude: [MIGRATION_056] });
    await seedTask('queued');
    await expect(
      testPool.query(`UPDATE media_tasks SET status = 'submitting' WHERE id = 't1'`),
    ).rejects.toThrow();
  });

  test('已应用 054/055 的旧库，补跑 056 后能写入 submitting', async () => {
    await runMigrations({ exclude: [MIGRATION_056] });
    await seedTask('queued');
    await runMigrations();
    await testPool.query(`UPDATE media_tasks SET status = 'submitting' WHERE id = 't1'`);
    const r = await testPool.query<{ status: string }>(
      `SELECT status FROM media_tasks WHERE id = 't1'`,
    );
    expect(r.rows[0].status).toBe('submitting');
  });

  test('其他状态仍然合法（迁移没有把 CHECK 放宽成什么都行）', async () => {
    await runMigrations();
    await seedTask('queued');
    for (const status of ['running', 'succeeded', 'failed', 'cancelled']) {
      await testPool.query(`UPDATE media_tasks SET status = $1 WHERE id = 't1'`, [status]);
    }
    await expect(
      testPool.query(`UPDATE media_tasks SET status = 'bogus' WHERE id = 't1'`),
    ).rejects.toThrow();
  });

  test('重复执行不报错（幂等）', async () => {
    await runMigrations();
    await runMigrations();
    await seedTask('submitting');
    const r = await testPool.query<{ status: string }>(
      `SELECT status FROM media_tasks WHERE id = 't1'`,
    );
    expect(r.rows[0].status).toBe('submitting');
  });
});
