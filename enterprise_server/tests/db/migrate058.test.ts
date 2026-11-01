import '../helpers/setupEnv';

import { beforeEach, describe, expect, test } from 'vitest';

import { resetSchema, runMigrations, testPool } from '../../src/db/testDb';

const MIGRATION_058 = '058_provider_cards.sql';

async function seedOrg(): Promise<void> {
  await testPool.query(`INSERT INTO orgs(id,name) VALUES ('o1','T') ON CONFLICT DO NOTHING`);
  await testPool.query(
    `INSERT INTO users(id,org_id,username,password_hash) VALUES ('u1','o1','u1','x') ON CONFLICT DO NOTHING`,
  );
}

async function seedKey(
  id: string,
  provider: string,
  protocol: string,
  opts: { builtin?: boolean; createdAt?: string; label?: string } = {},
): Promise<void> {
  await testPool.query(
    `INSERT INTO provider_keys(id, org_id, provider, protocol, is_builtin, created_at, label)
     VALUES ($1,'o1',$2,$3,$4,COALESCE($5::timestamptz, now()),$6)`,
    [id, provider, protocol, opts.builtin ?? false, opts.createdAt ?? null, opts.label ?? null],
  );
}

async function cardIdOf(keyId: string): Promise<string | null> {
  const r = await testPool.query<{ card_id: string | null }>(
    `SELECT card_id FROM provider_keys WHERE id = $1`,
    [keyId],
  );
  return r.rows[0]?.card_id ?? null;
}

/**
 * Migrate to 057, seed the provider rows, THEN apply 058.
 *
 * The order matters: 058 is a data migration, so it only sees the rows that
 * existed when it ran. Seeding afterwards would leave every card_id NULL and
 * the backfill untested.
 */
async function migrateWithKeys(seed: () => Promise<void>): Promise<void> {
  await runMigrations({ exclude: [MIGRATION_058] });
  await seedOrg();
  await seed();
  await runMigrations();
}

describe('db/migrate 058 (provider_cards)', () => {
  beforeEach(async () => {
    await resetSchema();
  });

  test('每行 provider_keys 都拿到 card_id', async () => {
    await migrateWithKeys(async () => {
      await seedKey('k1', 'minimax', 'openai');
      await seedKey('k2', 'minimax', 'image-gen');
    });
    expect(await cardIdOf('k1')).not.toBeNull();
    expect(await cardIdOf('k2')).not.toBeNull();
  });

  test('同厂商不同协议的行落在同一张卡片', async () => {
    await migrateWithKeys(async () => {
      await seedKey('k1', 'minimax', 'openai');
      await seedKey('k2', 'minimax', 'image-gen');
    });
    const a = await cardIdOf('k1');
    expect(a).not.toBeNull();
    expect(await cardIdOf('k2')).toBe(a);
  });

  test('同厂商同协议的两行落在不同卡片，且第二张有独立前缀', async () => {
    await migrateWithKeys(async () => {
      await seedKey('k1', 'minimax', 'openai', { builtin: true, createdAt: '2026-01-01' });
      await seedKey('k2', 'minimax', 'openai', { createdAt: '2026-02-01' });
    });
    const a = await cardIdOf('k1');
    const b = await cardIdOf('k2');
    expect(a).not.toBeNull();
    expect(b).not.toBeNull();
    expect(a).not.toBe(b);
    const rows = await testPool.query<{ label: string | null }>(
      `SELECT label FROM provider_cards WHERE id = ANY($1::text[]) ORDER BY label NULLS FIRST`,
      [[a, b]],
    );
    // slot 0 → label NULL; slot 1 → 'minimax #2'
    expect(rows.rows[0].label).toBeNull();
    expect(rows.rows[1].label).toBe('minimax #2');
  });

  test('没有任何 provider_keys 时不产生卡片', async () => {
    await runMigrations();
    await seedOrg();
    const r = await testPool.query<{ n: number }>(`SELECT count(*)::int AS n FROM provider_cards`);
    expect(r.rows[0].n).toBe(0);
  });

  test('重复执行不报错（幂等）', async () => {
    await migrateWithKeys(async () => {
      await seedKey('k1', 'minimax', 'openai');
    });
    await runMigrations();
    const r = await testPool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM provider_cards WHERE id = 'card:' || md5('o1:minimax:0')`,
    );
    expect(r.rows[0].n).toBe(1);
  });

  test('已应用 057 的旧库，补跑 058 后行才拿到 card_id', async () => {
    await runMigrations({ exclude: [MIGRATION_058] });
    await seedOrg();
    await seedKey('k1', 'minimax', 'openai');
    // Before 058 the column does not exist at all — the old database has no
    // notion of a card.
    const before = await testPool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'provider_keys' AND column_name = 'card_id'`,
    );
    expect(before.rows[0].n).toBe(0);
    await runMigrations();
    expect(await cardIdOf('k1')).not.toBeNull();
  });
});
