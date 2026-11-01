import '../helpers/setupEnv';

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import { runMigrations } from '../../src/db/migrate';
import { resetSchema, testPool } from '../../src/db/testDb';

/**
 * The ledger keys on the file NAME, so a migration that was applied and then
 * EDITED never runs again — its schema change is silently missing from every
 * existing database, and the failure surfaces far away as a missing column.
 *
 * These tests pin the guard that makes that mistake loud instead of silent.
 */
describe('db/migrate (drift detection)', () => {
  let dir: string;

  beforeEach(async () => {
    await resetSchema();
    dir = mkdtempSync(join(tmpdir(), 'mixwork-migrations-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test('已应用的文件被改动后，报告为 drift', async () => {
    writeFileSync(join(dir, '001_x.sql'), 'CREATE TABLE t1(id TEXT);\n');
    const first = await runMigrations(testPool, { dir });
    expect(first.applied).toEqual(['001_x.sql']);
    expect(first.drifted).toEqual([]);

    writeFileSync(join(dir, '001_x.sql'), 'CREATE TABLE t1(id TEXT, extra TEXT);\n');
    const second = await runMigrations(testPool, { dir });
    expect(second.drifted).toEqual(['001_x.sql']);
    // And it is NOT re-applied: the ledger says it ran, and re-running a
    // changed file is not the runner's call to make.
    expect(second.applied).toEqual([]);
  });

  test('drift 会打一条明确的错误日志', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      writeFileSync(join(dir, '001_x.sql'), 'CREATE TABLE t1(id TEXT);\n');
      await runMigrations(testPool, { dir });
      writeFileSync(join(dir, '001_x.sql'), 'CREATE TABLE t1(id TEXT, extra TEXT);\n');
      await runMigrations(testPool, { dir });
      expect(spy).toHaveBeenCalled();
      expect(String(spy.mock.calls[0]?.[0])).toContain('001_x.sql');
      expect(String(spy.mock.calls[0]?.[0])).toContain('NEW migration file');
    } finally {
      spy.mockRestore();
    }
  });

  test('只改注释不算 drift', async () => {
    writeFileSync(join(dir, '001_x.sql'), 'CREATE TABLE t1(id TEXT);\n');
    await runMigrations(testPool, { dir });
    writeFileSync(join(dir, '001_x.sql'), '-- a reworded comment\nCREATE TABLE t1(id TEXT);\n');
    const second = await runMigrations(testPool, { dir });
    expect(second.drifted).toEqual([]);
  });

  test('新文件在下一轮被应用，schema 追上', async () => {
    writeFileSync(join(dir, '001_x.sql'), 'CREATE TABLE t1(id TEXT);\n');
    await runMigrations(testPool, { dir });
    writeFileSync(join(dir, '002_y.sql'), 'ALTER TABLE t1 ADD COLUMN c TEXT;\n');
    const second = await runMigrations(testPool, { dir });
    expect(second.applied).toEqual(['002_y.sql']);
    const col = await testPool.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns WHERE table_name = 't1' AND column_name = 'c'`,
    );
    expect(col.rows).toHaveLength(1);
  });

  test('ledger 记录 checksum', async () => {
    writeFileSync(join(dir, '001_x.sql'), 'CREATE TABLE t1(id TEXT);\n');
    await runMigrations(testPool, { dir });
    const row = await testPool.query<{ checksum: string | null }>(
      `SELECT checksum FROM _migrations WHERE file = '001_x.sql'`,
    );
    expect(row.rows[0].checksum).toMatch(/^[0-9a-f]{64}$/);
  });
});
