import '../helpers/setupEnv';

import { beforeEach, describe, expect, test, vi } from 'vitest';
vi.mock('../../src/db/pool', async () => {
  const td = await import('../../src/db/testDb');
  return { pool: td.testPool };
});

import { Hono } from 'hono';

import { signToken } from '../../src/auth/jwt';
import { resetSchema, runMigrations, testPool } from '../../src/db/testDb';
import { adminProviderKeyRoutes } from '../../src/routes/admin/providerKeys';

const app = new Hono();
app.route('/', adminProviderKeyRoutes);

async function admin(org = 'o1'): Promise<string> {
  return signToken({ sub: 'u1', orgId: org, roles: ['super_admin'] });
}

async function cardIdOf(keyId: string): Promise<string | null> {
  const r = await testPool.query<{ card_id: string | null }>(
    `SELECT card_id FROM provider_keys WHERE id = $1`,
    [keyId],
  );
  return r.rows[0]?.card_id ?? null;
}

async function createKey(body: Record<string, unknown>): Promise<Response> {
  const tok = await admin();
  return app.request('/admin/provider-keys', {
    method: 'POST',
    headers: { authorization: `Bearer ${tok}`, 'content-type': 'application/json' },
    body: JSON.stringify({ orgId: 'o1', provider: 'minimax', apiKey: 'sk-x', ...body }),
  });
}

describe('POST /admin/provider-keys 的卡片归属', () => {
  beforeEach(async () => {
    await resetSchema();
    await runMigrations();
    await testPool.query(`INSERT INTO orgs(id,name) VALUES ('o1','A') ON CONFLICT DO NOTHING`);
    await testPool.query(
      `INSERT INTO users(id, org_id, username, password_hash) VALUES ('u1','o1','u1','x')`,
    );
  });

  test('带 cardId 建密钥 → 挂到指定的那张卡片', async () => {
    // 两张同厂商的卡片：默认卡（label 为空，前缀=厂商名）和一张改名卡。
    // 自动归卡会挑默认卡，所以这里能区分"用了 cardId"和"自动归卡"。
    await testPool.query(
      `INSERT INTO provider_cards(id, org_id, provider, label) VALUES
         ('c-default','o1','minimax',NULL),
         ('c-renamed','o1','minimax','MiniMax 备份')`,
    );
    const res = await createKey({ cardId: 'c-renamed' });
    expect(res.status).toBe(200);
    const { id } = (await res.json()) as { id: string };
    expect(await cardIdOf(id)).toBe('c-renamed');
  });

  test('cardId 指向别的组织 → 400 card_not_found', async () => {
    await testPool.query(`INSERT INTO orgs(id,name) VALUES ('o2','B')`);
    await testPool.query(
      `INSERT INTO provider_cards(id, org_id, provider) VALUES ('c-other','o2','minimax')`,
    );
    const res = await createKey({ cardId: 'c-other' });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe('card_not_found');
  });

  test('cardId 指向别的厂商的卡片 → 400 card_vendor_mismatch', async () => {
    await testPool.query(
      `INSERT INTO provider_cards(id, org_id, provider) VALUES ('c-kimi','o1','kimi')`,
    );
    const res = await createKey({ cardId: 'c-kimi' });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe('card_vendor_mismatch');
  });

  test('不带 cardId 建密钥 → 自动归卡', async () => {
    await testPool.query(
      `INSERT INTO provider_cards(id, org_id, provider) VALUES ('c-default','o1','minimax')`,
    );
    const res = await createKey({});
    expect(res.status).toBe(200);
    const { id } = (await res.json()) as { id: string };
    expect(await cardIdOf(id)).toBe('c-default');
  });
});
