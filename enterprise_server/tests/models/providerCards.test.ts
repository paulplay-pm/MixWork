import '../helpers/setupEnv';

import { beforeEach, describe, expect, test, vi } from 'vitest';

vi.mock('../../src/db/pool', async () => {
  const td = await import('../../src/db/testDb');
  return { pool: td.testPool };
});

import { resetSchema, runMigrations, testPool } from '../../src/db/testDb';
import { providerCards } from '../../src/models/providerCards';

async function seedOrg(): Promise<void> {
  await testPool.query(`INSERT INTO orgs(id,name) VALUES ('o1','T') ON CONFLICT DO NOTHING`);
  await testPool.query(
    `INSERT INTO users(id,org_id,username,password_hash) VALUES ('u1','o1','u1','x') ON CONFLICT DO NOTHING`,
  );
}

describe('models/providerCards', () => {
  beforeEach(async () => {
    await resetSchema();
    await runMigrations();
    await seedOrg();
  });

  test('新建一张卡片', async () => {
    const { id } = await providerCards.create({ orgId: 'o1', provider: 'minimax' });
    const card = await providerCards.getById('o1', id);
    expect(card?.provider).toBe('minimax');
    expect(card?.label).toBeNull();
    expect(card?.sections).toEqual([]);
  });

  test('同厂商同前缀再建一张卡片会被拒绝', async () => {
    await providerCards.create({ orgId: 'o1', provider: 'minimax' });
    await expect(
      providerCards.create({ orgId: 'o1', provider: 'minimax' }),
    ).rejects.toThrow(/card_duplicate/);
  });

  test('同厂商不同显示名可以并存', async () => {
    await providerCards.create({ orgId: 'o1', provider: 'minimax' });
    const { id } = await providerCards.create({ orgId: 'o1', provider: 'minimax', label: 'MiniMax 备份' });
    const card = await providerCards.getById('o1', id);
    expect(card?.label).toBe('MiniMax 备份');
  });

  test('卡片总开关关掉后所有分区都停用', async () => {
    const { id } = await providerCards.create({ orgId: 'o1', provider: 'minimax' });
    await testPool.query(
      `INSERT INTO provider_keys(id, org_id, provider, protocol, card_id, enabled, api_key_masked)
       VALUES ('k1','o1','minimax','openai',$1,true,'sk-***')`,
      [id],
    );
    await providerCards.patch('o1', id, { enabled: false });
    const card = await providerCards.getById('o1', id);
    expect(card?.enabled).toBe(false);
    expect(card?.sections[0].enabled).toBe(false);
  });

  test('卡片重新打开时恢复各分区自身的状态', async () => {
    const { id } = await providerCards.create({ orgId: 'o1', provider: 'minimax' });
    await testPool.query(
      `INSERT INTO provider_keys(id, org_id, provider, protocol, card_id, enabled, api_key_masked)
       VALUES ('k-on','o1','minimax','openai',$1,true,'sk-***'),
              ('k-off','o1','minimax','image-gen',$1,false,'sk-***'),
              ('k-nokey','o1','minimax','realtime-asr',$1,false,NULL)`,
      [id],
    );
    await providerCards.patch('o1', id, { enabled: false });
    await providerCards.patch('o1', id, { enabled: true });
    const rows = await testPool.query<{ id: string; enabled: boolean }>(
      `SELECT id, enabled FROM provider_keys WHERE card_id=$1`, [id]);
    const byId = Object.fromEntries(rows.rows.map((r) => [r.id, r.enabled]));
    // What was on comes back on...
    expect(byId['k-on']).toBe(true);
    // ...and what the admin had switched off STAYS off: the master switch
    // restores, it does not enable everything that has a key.
    expect(byId['k-off']).toBe(false);
    // A keyless section cannot authenticate, so it never comes back on.
    expect(byId['k-nokey']).toBe(false);
  });

  test('删除卡片会连带删除分区和模型', async () => {
    const { id } = await providerCards.create({ orgId: 'o1', provider: 'minimax' });
    await testPool.query(
      `INSERT INTO provider_keys(id, org_id, provider, protocol, card_id, enabled)
       VALUES ('k1','o1','minimax','image-gen',$1,true)`,
      [id],
    );
    await testPool.query(
      `INSERT INTO model_catalog(id, org_id, provider_key_id, provider, model, types)
       VALUES ('m1','o1','k1','minimax','image-01',ARRAY['image-gen'])`,
    );
    const r = await providerCards.remove('o1', id);
    expect(r.deletedKeys).toBe(1);
    expect(r.deletedModels).toBe(1);
    const m = await testPool.query<{ n: number }>(`SELECT count(*)::int AS n FROM model_catalog`);
    expect(m.rows[0].n).toBe(0);
  });

  test('list 返回按厂商分组的分区', async () => {
    const { id } = await providerCards.create({ orgId: 'o1', provider: 'minimax' });
    await testPool.query(
      `INSERT INTO provider_keys(id, org_id, provider, protocol, card_id, enabled)
       VALUES ('k1','o1','minimax','openai',$1,true),
              ('k2','o1','minimax','image-gen',$1,true)`,
      [id],
    );
    const cards = await providerCards.list('o1');
    expect(cards).toHaveLength(1);
    expect(cards[0].sections.map((s) => s.protocol)).toEqual(['openai', 'image-gen']);
  });
});
