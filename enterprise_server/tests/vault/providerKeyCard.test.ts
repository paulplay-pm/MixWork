import '../helpers/setupEnv';

import { beforeEach, describe, expect, test, vi } from 'vitest';

vi.mock('../../src/db/pool', async () => {
  const td = await import('../../src/db/testDb');
  return { pool: td.testPool };
});

import { resetSchema, runMigrations, testPool } from '../../src/db/testDb';
import { cardIdForSlot } from '../../src/models/providerCards';
import { providerKeyVault } from '../../src/vault/providerKeyVault';

async function cardIdOf(keyId: string): Promise<string | null> {
  const r = await testPool.query<{ card_id: string | null }>(
    `SELECT card_id FROM provider_keys WHERE id = $1`,
    [keyId],
  );
  return r.rows[0]?.card_id ?? null;
}

describe('providerKeyVault 的卡片归属', () => {
  beforeEach(async () => {
    await resetSchema();
    await runMigrations();
    await testPool.query(`INSERT INTO orgs(id, name) VALUES ('o1', 'A')`);
    await testPool.query(
      `INSERT INTO users(id, org_id, username, password_hash) VALUES ('root', 'o1', 'r', 'x')`,
    );
  });

  test('显式传入 cardId 时，密钥挂到那张卡片上', async () => {
    await testPool.query(
      `INSERT INTO provider_cards(id, org_id, provider) VALUES ('c1', 'o1', 'minimax')`,
    );
    const { id } = await providerKeyVault.add({
      orgId: 'o1',
      provider: 'minimax',
      plaintextKey: 'sk-x',
      cardId: 'c1',
    });
    expect(await cardIdOf(id)).toBe('c1');
  });

  test('不传 cardId 时自动建卡，槽位 0 用确定性 id', async () => {
    const { id } = await providerKeyVault.add({
      orgId: 'o1',
      provider: 'minimax',
      plaintextKey: 'sk-x',
    });
    expect(await cardIdOf(id)).toBe(cardIdForSlot('o1', 'minimax', 0));
    const cards = await testPool.query<{ id: string; label: string | null }>(
      `SELECT id, label FROM provider_cards WHERE org_id = 'o1'`,
    );
    expect(cards.rows).toHaveLength(1);
    expect(cards.rows[0].label).toBeNull();
  });

  test('同厂商同协议的第二个密钥落到槽位 1，不与第一个同卡', async () => {
    const a = await providerKeyVault.add({ orgId: 'o1', provider: 'minimax', plaintextKey: 'sk-a' });
    const b = await providerKeyVault.add({ orgId: 'o1', provider: 'minimax', plaintextKey: 'sk-b' });
    expect(await cardIdOf(a.id)).toBe(cardIdForSlot('o1', 'minimax', 0));
    expect(await cardIdOf(b.id)).toBe(cardIdForSlot('o1', 'minimax', 1));
    expect(await cardIdOf(a.id)).not.toBe(await cardIdOf(b.id));
  });

  test('同厂商不同协议的密钥落在同一张卡片', async () => {
    const a = await providerKeyVault.add({ orgId: 'o1', provider: 'minimax', plaintextKey: 'sk-a' });
    const b = await providerKeyVault.add({
      orgId: 'o1',
      provider: 'minimax',
      plaintextKey: 'sk-b',
      protocol: 'image-gen',
    });
    expect(await cardIdOf(b.id)).toBe(await cardIdOf(a.id));
  });

  test('控制台建的卡片（随机 id）会被后来的密钥认领', async () => {
    await testPool.query(
      `INSERT INTO provider_cards(id, org_id, provider) VALUES ('card:console-uuid', 'o1', 'minimax')`,
    );
    const { id } = await providerKeyVault.add({ orgId: 'o1', provider: 'minimax', plaintextKey: 'sk-x' });
    expect(await cardIdOf(id)).toBe('card:console-uuid');
  });
});
