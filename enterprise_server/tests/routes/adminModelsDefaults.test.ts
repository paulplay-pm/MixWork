import '../helpers/setupEnv';

import { beforeEach, describe, expect, test, vi } from 'vitest';

vi.mock('../../src/db/pool', async () => {
  const td = await import('../../src/db/testDb');
  return { pool: td.testPool };
});

import { Hono } from 'hono';

import { signToken } from '../../src/auth/jwt';
import { resetSchema, runMigrations, testPool } from '../../src/db/testDb';
import { modelTypeDefaults } from '../../src/models/modelTypeDefaults';
import { adminModelRoutes } from '../../src/routes/admin/models';
import { providerKeyVault } from '../../src/vault/providerKeyVault';

const app = new Hono();
app.route('/', adminModelRoutes);

async function token(orgId: string, userId: string): Promise<string> {
  return signToken({ sub: userId, orgId, roles: ['model_admin'] });
}

const auth = (t: string) => ({ authorization: `Bearer ${t}`, 'content-type': 'application/json' });

describe('routes/admin/models (defaultForType + parameterSpec)', () => {
  beforeEach(async () => {
    await resetSchema();
    await runMigrations();
    await testPool.query(`INSERT INTO orgs(id, name, timezone) VALUES ('o1','T','UTC') ON CONFLICT DO NOTHING`);
    await testPool.query(`INSERT INTO users(id, org_id, username, password_hash) VALUES ('u1','o1','u','x') ON CONFLICT DO NOTHING`);
  });

  async function seedModel(types: string[], model = 'img-1'): Promise<string> {
    const k = await providerKeyVault.add({
      orgId: 'o1',
      provider: 'minimax',
      plaintextKey: 'k',
      protocol: 'image-gen',
    });
    const r = await testPool.query<{ id: string }>(
      `INSERT INTO model_catalog(id, org_id, provider_key_id, provider, model, types)
       VALUES ('m-' || $3, 'o1', $1, 'minimax', $2, $4::text[])
       RETURNING id`,
      [k.id, model, model, types],
    );
    return r.rows[0].id;
  }

  test('把某个模型设为某类型的默认', async () => {
    const t = await token('o1', 'u1');
    const id = await seedModel(['image-gen']);
    const res = await app.request(`/admin/models/${id}?orgId=o1`, {
      method: 'PATCH',
      headers: auth(t),
      body: JSON.stringify({ defaultForType: { type: 'image-gen', isDefault: true } }),
    });
    expect(res.status).toBe(200);
    expect(await modelTypeDefaults.get('o1', 'image-gen')).toBe(id);
  });

  test('模型不带该类型 → 400 type_mismatch', async () => {
    const t = await token('o1', 'u1');
    const id = await seedModel(['image-gen']);
    const res = await app.request(`/admin/models/${id}?orgId=o1`, {
      method: 'PATCH',
      headers: auth(t),
      body: JSON.stringify({ defaultForType: { type: 'video-gen', isDefault: true } }),
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe('type_mismatch');
  });

  test('未知类型 → 400 validation_error', async () => {
    const t = await token('o1', 'u1');
    const id = await seedModel(['image-gen']);
    const res = await app.request(`/admin/models/${id}?orgId=o1`, {
      method: 'PATCH',
      headers: auth(t),
      body: JSON.stringify({ defaultForType: { type: 'nope', isDefault: true } }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string; field: string };
    expect(body.error).toBe('validation_error');
    expect(body.field).toBe('defaultForType.type');
  });

  test('取消默认', async () => {
    const t = await token('o1', 'u1');
    const id = await seedModel(['image-gen']);
    await app.request(`/admin/models/${id}?orgId=o1`, {
      method: 'PATCH',
      headers: auth(t),
      body: JSON.stringify({ defaultForType: { type: 'image-gen', isDefault: true } }),
    });
    const res = await app.request(`/admin/models/${id}?orgId=o1`, {
      method: 'PATCH',
      headers: auth(t),
      body: JSON.stringify({ defaultForType: { type: 'image-gen', isDefault: false } }),
    });
    expect(res.status).toBe(200);
    expect(await modelTypeDefaults.get('o1', 'image-gen')).toBeNull();
  });

  test('取消别人的默认是无操作（不清除）', async () => {
    const t = await token('o1', 'u1');
    const a = await seedModel(['image-gen'], 'a');
    const b = await seedModel(['image-gen'], 'b');
    await modelTypeDefaults.set('o1', 'image-gen', a);
    const res = await app.request(`/admin/models/${b}?orgId=o1`, {
      method: 'PATCH',
      headers: auth(t),
      body: JSON.stringify({ defaultForType: { type: 'image-gen', isDefault: false } }),
    });
    expect(res.status).toBe(200);
    expect(await modelTypeDefaults.get('o1', 'image-gen')).toBe(a);
  });

  test('GET /admin/model-type-defaults 列出本组织的默认', async () => {
    const t = await token('o1', 'u1');
    const id = await seedModel(['image-gen']);
    await modelTypeDefaults.set('o1', 'image-gen', id);
    const res = await app.request('/admin/model-type-defaults?orgId=o1', { headers: auth(t) });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([{ type: 'image-gen', modelId: id }]);
  });

  test('GET /admin/model-type-defaults 拒绝别的组织', async () => {
    const t = await token('o1', 'u1');
    const res = await app.request('/admin/model-type-defaults?orgId=o2', { headers: auth(t) });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe('org_mismatch');
  });

  test('POST /admin/models 写入 parameterSpec', async () => {
    const t = await token('o1', 'u1');
    const k = await providerKeyVault.add({ orgId: 'o1', provider: 'minimax', plaintextKey: 'k' });
    const res = await app.request('/admin/models', {
      method: 'POST',
      headers: auth(t),
      body: JSON.stringify({
        orgId: 'o1',
        providerKeyId: k.id,
        provider: 'minimax',
        model: 'img-2',
        parameterSpec: { size: '1024x1024' },
      }),
    });
    expect(res.status).toBe(200);
    const { id } = (await res.json()) as { id: string };
    const row = await testPool.query<{ parameter_spec: unknown }>(
      `SELECT parameter_spec FROM model_catalog WHERE id = $1`,
      [id],
    );
    expect(row.rows[0].parameter_spec).toEqual({ size: '1024x1024' });
  });

  test('PATCH /admin/models 更新 parameterSpec', async () => {
    const t = await token('o1', 'u1');
    const id = await seedModel(['image-gen']);
    const res = await app.request(`/admin/models/${id}?orgId=o1`, {
      method: 'PATCH',
      headers: auth(t),
      body: JSON.stringify({ parameterSpec: { size: '512x512' } }),
    });
    expect(res.status).toBe(200);
    const row = await testPool.query<{ parameter_spec: unknown }>(
      `SELECT parameter_spec FROM model_catalog WHERE id = $1`,
      [id],
    );
    expect(row.rows[0].parameter_spec).toEqual({ size: '512x512' });
  });

  // The console issues secondary PATCHes that carry only one field (the
  // model's enable switch, the per-type default). A PATCH must not touch the
  // columns it does not mention — otherwise flipping a switch wipes the
  // admin's display name.
  test('不带 displayName 的 PATCH 不会清空显示名', async () => {
    const t = await token('o1', 'u1');
    const id = await seedModel(['image-gen']);
    await testPool.query(`UPDATE model_catalog SET display_name='MiniMax 图像' WHERE id=$1`, [id]);

    const res = await app.request(`/admin/models/${id}?orgId=o1`, {
      method: 'PATCH',
      headers: auth(t),
      body: JSON.stringify({ enabled: false }),
    });
    expect(res.status).toBe(200);
    const row = await testPool.query<{ display_name: string | null; enabled: boolean }>(
      `SELECT display_name, enabled FROM model_catalog WHERE id=$1`, [id]);
    expect(row.rows[0].enabled).toBe(false);
    expect(row.rows[0].display_name).toBe('MiniMax 图像');
  });

  test('PATCH /admin/models 拒绝非对象的 parameterSpec', async () => {
    const t = await token('o1', 'u1');
    const id = await seedModel(['image-gen']);
    const res = await app.request(`/admin/models/${id}?orgId=o1`, {
      method: 'PATCH',
      headers: auth(t),
      body: JSON.stringify({ parameterSpec: 'nope' }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string; field: string };
    expect(body.error).toBe('validation_error');
    expect(body.field).toBe('parameterSpec');
  });
});
