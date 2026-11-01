import '../helpers/setupEnv';

import { beforeEach, describe, expect, test, vi } from 'vitest';
vi.mock('../../src/db/pool', async () => {
  const td = await import('../../src/db/testDb');
  return { pool: td.testPool };
});
import { resetSchema, runMigrations, testPool } from '../../src/db/testDb';

async function columnsOf(table: string): Promise<string[]> {
  const r = await testPool.query<{ column_name: string }>(
    `SELECT column_name FROM information_schema.columns WHERE table_name = $1`, [table]);
  return r.rows.map((x) => x.column_name);
}

/**
 * token_usage.model_id is a live FK to model_catalog(id) (migration 004), and
 * model_catalog.provider_key_id is a live FK to provider_keys(id) (002), whose
 * org_id is a live FK to orgs(id). Seed the whole chain so a token_usage row
 * can be inserted at all.
 */
async function seedCatalogChain(): Promise<string> {
  await testPool.query(`INSERT INTO orgs(id, name, timezone) VALUES ('o1', 'T', 'UTC')`);
  await testPool.query(
    `INSERT INTO provider_keys(id, org_id, provider, api_key_encrypted) VALUES ('k1', 'o1', 'p', 'x')`
  );
  await testPool.query(
    `INSERT INTO model_catalog(id, org_id, provider_key_id, provider, model) VALUES ('m1', 'o1', 'k1', 'p', 'm')`
  );
  return 'm1';
}

describe('migration 052', () => {
  beforeEach(async () => { await resetSchema(); await runMigrations(); });

  test('token_usage gains usage_missing defaulting to false', async () => {
    expect(await columnsOf('token_usage')).toContain('usage_missing');
    await seedCatalogChain();
    // Column omitted on purpose: existing rows and new inserts must read as a
    // definite false, not NULL.
    const r = await testPool.query<{ usage_missing: boolean }>(
      `INSERT INTO token_usage(org_id,user_id,model_id,provider,token_in,token_out,total_tokens,result_code,quota_window_date)
       VALUES ('o1','u1','m1','p',0,0,0,200,'2026-01-01') RETURNING usage_missing`);
    expect(r.rows[0].usage_missing).toBe(false);
  });

  test('provider_keys gains a nullable stream_usage_supported', async () => {
    expect(await columnsOf('provider_keys')).toContain('stream_usage_supported');
    // No default: NULL means "not yet tried", false means "proved unsupported".
    const r = await testPool.query<{ is_nullable: string; column_default: string | null }>(
      `SELECT is_nullable, column_default FROM information_schema.columns
       WHERE table_name = 'provider_keys' AND column_name = 'stream_usage_supported'`);
    expect(r.rows[0].is_nullable).toBe('YES');
    expect(r.rows[0].column_default).toBeNull();
  });

  test('both new indexes exist', async () => {
    const r = await testPool.query<{ indexname: string }>(
      `SELECT indexname FROM pg_indexes WHERE indexname IN ('token_usage_org_ts','audit_events_org_ts_action')`);
    expect(r.rows.map((x) => x.indexname).sort())
      .toEqual(['audit_events_org_ts_action', 'token_usage_org_ts']);
  });

  test('usage points are granted to super_admin, auditor and org_admin', async () => {
    const r = await testPool.query<{ name: string; permissions: string[] }>(
      `SELECT name, permissions FROM roles
       WHERE name IN ('super_admin','auditor','org_admin')`);
    expect(r.rowCount).toBe(3);
    for (const row of r.rows) {
      expect(row.permissions).toContain('usage:view');
      expect(row.permissions).toContain('usage:export');
    }
  });

  test('an already-deployed database gets the points, not just a fresh one', async () => {
    // Replay the schema, then roll the three roles back to their pre-052
    // (029-seeded) permission arrays to stand in for an existing deployment
    // whose roles.permissions JSONB was written before the usage points
    // existed. BUILTIN_ROLE_POINTS only feeds the 029 INSERT, so this is the
    // only thing that can grant these points here.
    const pre052: Record<string, string[]> = {
      super_admin: ['audit:view', 'agent:publish'],
      org_admin: ['user:view', 'agent:publish'],
      auditor: ['audit:view', 'audit:export'],
    };
    for (const [name, points] of Object.entries(pre052)) {
      await testPool.query(
        `UPDATE roles SET permissions = $2::jsonb WHERE name = $1`,
        [name, JSON.stringify(points)]
      );
    }
    // Assert the rollback really removed the points before re-running.
    const before = await testPool.query<{ permissions: string[] }>(
      `SELECT permissions FROM roles WHERE name = 'auditor'`);
    expect(before.rows[0].permissions).not.toContain('usage:view');

    await runMigrations();

    const after = await testPool.query<{ name: string; permissions: string[] }>(
      `SELECT name, permissions FROM roles WHERE name IN ('super_admin','auditor','org_admin')`);
    expect(after.rowCount).toBe(3);
    for (const row of after.rows) {
      expect(row.permissions).toContain('usage:view');
      expect(row.permissions).toContain('usage:export');
      // Pre-existing points survive the append.
      for (const p of pre052[row.name]) expect(row.permissions).toContain(p);
    }
  });

  test('re-running is idempotent', async () => {
    await runMigrations();
    await runMigrations();
    const r = await testPool.query<{ permissions: string[] }>(
      `SELECT permissions FROM roles WHERE name='auditor'`);
    expect(r.rows[0].permissions.filter((p) => p === 'usage:view')).toHaveLength(1);
  });
});
