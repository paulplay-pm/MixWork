import '../helpers/setupEnv';

import { beforeEach, describe, expect, test } from 'vitest';

import { resetSchema, runMigrations, testPool } from '../../src/db/testDb';

const MIGRATION_055 = '055_media_tasks_provider_key_id.sql';

const columnNames = async (table: string): Promise<string[]> => {
  const r = await testPool.query<{ column_name: string }>(
    `SELECT column_name FROM information_schema.columns WHERE table_name = $1`,
    [table],
  );
  return r.rows.map((x) => x.column_name);
};

describe('db/migrate 055 (media_tasks.provider_key_id)', () => {
  beforeEach(async () => {
    await resetSchema();
  });

  test('media_tasks 带 provider_key_id 列', async () => {
    await runMigrations();
    expect(await columnNames('media_tasks')).toContain('provider_key_id');
  });

  /**
   * The bug this migration exists for.
   *
   * 054 was applied by every deployed database and recorded in the
   * `_migrations` ledger, and the runner skips a file whose NAME is in the
   * ledger. The column was added by EDITING 054, so on an existing database
   * the edit was never executed: `media_tasks.provider_key_id` did not exist,
   * and both the generate route's INSERT and the worker's claim query failed
   * with `column "provider_key_id" does not exist`.
   *
   * So the state that matters is not "a fresh database" but "a database that
   * already applied 054" — this test replays exactly that state, then applies
   * the new file and asserts the schema caught up.
   */
  test('已应用 054 的库，补跑 055 后拿到 provider_key_id 列', async () => {
    // The deployed state: everything up to and including 054, without 055.
    await runMigrations({ exclude: [MIGRATION_055] });
    expect(await columnNames('media_tasks')).not.toContain('provider_key_id');

    // The new migration brings the existing database up to date.
    await runMigrations();
    expect(await columnNames('media_tasks')).toContain('provider_key_id');
  });

  test('provider_key_id 的部分索引存在', async () => {
    await runMigrations();
    const idx = await testPool.query<{ indexname: string }>(
      `SELECT indexname FROM pg_indexes WHERE tablename = 'media_tasks' AND indexname = 'media_tasks_provider_key_idx'`,
    );
    expect(idx.rows).toHaveLength(1);
  });

  test('重复执行不报错（幂等）', async () => {
    await runMigrations();
    await runMigrations();
    expect(await columnNames('media_tasks')).toContain('provider_key_id');
  });
});
