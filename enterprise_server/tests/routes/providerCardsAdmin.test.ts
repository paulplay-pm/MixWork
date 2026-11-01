import '../helpers/setupEnv';

import { beforeEach, describe, expect, test, vi } from 'vitest';

vi.mock('../../src/db/pool', async () => {
  const td = await import('../../src/db/testDb');
  return { pool: td.testPool };
});

import { Hono } from 'hono';

import { signToken } from '../../src/auth/jwt';
import { resetSchema, runMigrations, testPool } from '../../src/db/testDb';
import { adminProviderCardRoutes } from '../../src/routes/admin/providerCards';

function buildApp(): Hono {
  const app = new Hono();
  app.route('/', adminProviderCardRoutes);
  return app;
}

async function adminToken(orgId: string, userId: string): Promise<string> {
  return signToken({ sub: userId, orgId, roles: ['model_admin'] });
}

describe('routes/admin/providerCards', () => {
  beforeEach(async () => {
    await resetSchema();
    await runMigrations();
    await testPool.query(`INSERT INTO orgs(id, name) VALUES ('o1', 'Test')`);
    await testPool.query(
      `INSERT INTO users(id, org_id, username, password_hash) VALUES ('root', 'o1', 'r', 'x')`,
    );
  });

  test('GET /admin/provider-cards requires auth (no token → 401)', async () => {
    const a = buildApp();
    const res = await a.request('/admin/provider-cards?orgId=o1');
    expect(res.status).toBe(401);
  });

  test('POST /admin/provider-cards rejects another org (org_mismatch)', async () => {
    const a = buildApp();
    const token = await adminToken('o1', 'root');
    const res = await a.request('/admin/provider-cards', {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ orgId: 'o2', provider: 'minimax' }),
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe('org_mismatch');
  });

  test('POST /admin/provider-cards twice with the same slug → 409 card_duplicate', async () => {
    const a = buildApp();
    const token = await adminToken('o1', 'root');
    const post = (body: unknown) =>
      a.request('/admin/provider-cards', {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
    const first = await post({ orgId: 'o1', provider: 'minimax' });
    expect(first.status).toBe(200);
    const second = await post({ orgId: 'o1', provider: 'minimax' });
    expect(second.status).toBe(409);
    expect(((await second.json()) as { error: string }).error).toBe('card_duplicate');
  });

  test('PATCH /admin/provider-cards 改名撞上已有前缀 → 409 card_duplicate', async () => {
    const a = buildApp();
    const token = await adminToken('o1', 'root');
    const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
    const first = await a.request('/admin/provider-cards', {
      method: 'POST', headers, body: JSON.stringify({ orgId: 'o1', provider: 'minimax' }),
    });
    expect(first.status).toBe(200);
    await testPool.query(
      `INSERT INTO provider_cards(id, org_id, provider, label) VALUES ('c-bak','o1','minimax','MiniMax 备份')`,
    );
    // Clearing the label makes the prefix fall back to the vendor slug, which
    // the first card already owns.
    const res = await a.request('/admin/provider-cards/c-bak', {
      method: 'PATCH', headers, body: JSON.stringify({ label: null }),
    });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: 'card_duplicate' });
    const row = await testPool.query<{ label: string | null }>(
      `SELECT label FROM provider_cards WHERE id='c-bak'`);
    expect(row.rows[0].label).toBe('MiniMax 备份');
  });

  test('DELETE /admin/provider-cards/:id of another org → 404 card_not_found', async () => {
    const a = buildApp();
    const token = await adminToken('o1', 'root');
    await testPool.query(`INSERT INTO orgs(id, name) VALUES ('o2', 'Other')`);
    await testPool.query(
      `INSERT INTO provider_cards(id, org_id, provider) VALUES ('c-other','o2','minimax')`,
    );
    const res = await a.request('/admin/provider-cards/c-other', {
      method: 'DELETE',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(404);
    expect(((await res.json()) as { error: string }).error).toBe('card_not_found');
  });

  test('GET /admin/provider-cards lists the org cards', async () => {
    const a = buildApp();
    const token = await adminToken('o1', 'root');
    await testPool.query(
      `INSERT INTO provider_cards(id, org_id, provider) VALUES ('c1','o1','minimax')`,
    );
    const res = await a.request('/admin/provider-cards?orgId=o1', {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { id: string; sections: unknown[] }[];
    expect(body).toHaveLength(1);
    expect(body[0].id).toBe('c1');
    expect(body[0].sections).toEqual([]);
  });
});
