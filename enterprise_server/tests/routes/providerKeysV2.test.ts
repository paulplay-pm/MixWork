import '../helpers/setupEnv';

import { beforeEach, describe, expect, test, vi } from 'vitest';
vi.mock('../../src/db/pool', async () => {
  const td = await import('../../src/db/testDb');
  return { pool: td.testPool };
});

import { Hono } from 'hono';

import { signToken } from '../../src/auth/jwt';
import { resetSchema, runMigrations, testPool } from '../../src/db/testDb';
import { seedBuiltinProviders } from '../../src/org/builtinProviders';
import { adminProviderKeyRoutes } from '../../src/routes/admin/providerKeys';

const app = new Hono();
app.route('/', adminProviderKeyRoutes);

async function admin(org = 'o1', roles: string[] = ['super_admin']) {
  await testPool.query(`INSERT INTO orgs(id,name) VALUES ('o1','A') ON CONFLICT DO NOTHING`);
  return signToken({ sub: 'u1', orgId: org, roles });
}

describe('provider routes v2', () => {
  beforeEach(async () => {
    await resetSchema();
    await runMigrations();
    // provider_keys.org_id is a NOT NULL FK to orgs(id); the org must exist
    // before seedBuiltinProviders can insert its rows. (The per-test admin()
    // helper also upserts this org — both inserts are idempotent no-ops.)
    await testPool.query(`INSERT INTO orgs(id,name) VALUES ('o1','A') ON CONFLICT DO NOTHING`);
    await seedBuiltinProviders('o1');
  });

  test('DELETE a builtin provider -> 409 builtin_provider + audit', async () => {
    const tok = await admin();
    const builtinId = (await testPool.query<{ id: string }>(
      `SELECT id FROM provider_keys WHERE org_id='o1' AND provider='openai' AND is_builtin`,
    )).rows[0].id;
    const res = await app.request(`/admin/provider-keys/${builtinId}`, {
      method: 'DELETE', headers: { authorization: `Bearer ${tok}` },
    });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: 'builtin_provider' });
    const audit = await testPool.query<{ n: number }>(
      `SELECT count(*)::int n FROM audit_events WHERE action='provider_key_builtin_delete'`);
    expect(audit.rows[0].n).toBe(1);
  });

  test('PATCH sets protocol and re-sets the key (write-only)', async () => {
    const tok = await admin();
    const id = (await testPool.query<{ id: string }>(
      `SELECT id FROM provider_keys WHERE org_id='o1' AND provider='anthropic' AND is_builtin`,
    )).rows[0].id;
    const res = await app.request(`/admin/provider-keys/${id}`, {
      method: 'PATCH',
      headers: { authorization: `Bearer ${tok}`, 'content-type': 'application/json' },
      body: JSON.stringify({ protocol: 'anthropic', apiKey: 'sk-ant-new-1234' }),
    });
    expect(res.status).toBe(200);
    const row = await testPool.query<{ protocol: string; api_key_masked: string | null }>(
      `SELECT protocol, api_key_masked FROM provider_keys WHERE id=$1`, [id]);
    expect(row.rows[0].protocol).toBe('anthropic');
    expect(row.rows[0].api_key_masked).toContain('•');
  });

  test('GET returns is_builtin + protocol + populated mask', async () => {
    const tok = await admin();
    const res = await app.request('/admin/provider-keys?orgId=o1', { headers: { authorization: `Bearer ${tok}` } });
    expect(res.status).toBe(200);
    const rows = (await res.json()) as Array<{ provider: string; is_builtin: boolean; protocol: string }>;
    const oai = rows.find((r) => r.provider === 'openai');
    expect(oai?.is_builtin).toBe(true);
    expect(oai?.protocol).toBe('openai');
  });

  test('POST a custom provider colliding a builtin slug is allowed (partial index)', async () => {
    const tok = await admin();
    const res = await app.request('/admin/provider-keys', {
      method: 'POST',
      headers: { authorization: `Bearer ${tok}`, 'content-type': 'application/json' },
      body: JSON.stringify({ orgId: 'o1', provider: 'openai', protocol: 'openai', endpoint: 'https://my-vllm/v1' }),
    });
    expect(res.status).toBe(200); // custom 'openai' is distinct from the builtin 'openai'
  });

  // Switching a section's protocol WITHIN the chat family keeps its model
  // list: openai and anthropic speak the same model ids, and the cataloged
  // models are the admin's own work — they must not vanish because a
  // compatibility switch was flipped.
  test('切换协议保留该分区的模型', async () => {
    const tok = await admin();
    const id = (await testPool.query<{ id: string }>(
      `SELECT id FROM provider_keys WHERE org_id='o1' AND provider='openai' AND is_builtin`,
    )).rows[0].id;
    const before = await testPool.query<{ n: number }>(
      `SELECT count(*)::int n FROM model_catalog WHERE provider_key_id=$1`, [id]);
    expect(before.rows[0].n).toBeGreaterThan(0);
    // Make one of them the chat default: it must survive the switch too.
    await testPool.query(
      `INSERT INTO model_type_defaults(org_id, type, model_id)
       SELECT 'o1','chat', id FROM model_catalog WHERE provider_key_id=$1 LIMIT 1`, [id]);

    const res = await app.request(`/admin/provider-keys/${id}`, {
      method: 'PATCH',
      headers: { authorization: `Bearer ${tok}`, 'content-type': 'application/json' },
      body: JSON.stringify({ protocol: 'anthropic' }),
    });
    expect(res.status).toBe(200);
    expect((await res.json() as { clearedModels?: number }).clearedModels).toBe(0);
    const after = await testPool.query<{ n: number }>(
      `SELECT count(*)::int n FROM model_catalog WHERE provider_key_id=$1`, [id]);
    expect(after.rows[0].n).toBe(before.rows[0].n);
    const defaults = await testPool.query<{ n: number }>(
      `SELECT count(*)::int n FROM model_type_defaults WHERE org_id='o1' AND type='chat'`);
    expect(defaults.rows[0].n).toBe(1);
  });

  // A switch ACROSS the chat boundary still invalidates the model list: a
  // chat model id means nothing to an ASR or image adapter, and the catalog
  // row would keep routing the desktop to a model the section can no longer
  // serve.
  test('跨协议族切换仍然清空该分区的模型', async () => {
    const tok = await admin();
    const id = (await testPool.query<{ id: string }>(
      `SELECT id FROM provider_keys WHERE org_id='o1' AND provider='openai' AND is_builtin`,
    )).rows[0].id;
    const before = await testPool.query<{ n: number }>(
      `SELECT count(*)::int n FROM model_catalog WHERE provider_key_id=$1`, [id]);
    expect(before.rows[0].n).toBeGreaterThan(0);

    const res = await app.request(`/admin/provider-keys/${id}`, {
      method: 'PATCH',
      headers: { authorization: `Bearer ${tok}`, 'content-type': 'application/json' },
      body: JSON.stringify({ protocol: 'image-gen' }),
    });
    expect(res.status).toBe(200);
    expect((await res.json() as { clearedModels?: number }).clearedModels).toBe(before.rows[0].n);
    const after = await testPool.query<{ n: number }>(
      `SELECT count(*)::int n FROM model_catalog WHERE provider_key_id=$1`, [id]);
    expect(after.rows[0].n).toBe(0);
  });

  test('切换协议不影响别的分区的模型', async () => {
    const tok = await admin();
    const id = (await testPool.query<{ id: string }>(
      `SELECT id FROM provider_keys WHERE org_id='o1' AND provider='openai' AND is_builtin`,
    )).rows[0].id;
    await testPool.query(
      `INSERT INTO provider_keys(id,org_id,provider,protocol,enabled) VALUES ('pk-img','o1','minimax','image-gen',true)`,
    );
    await testPool.query(
      `INSERT INTO model_catalog(id, org_id, provider_key_id, provider, model, type, types, enabled)
       VALUES ('mc-img','o1','pk-img','minimax','image-01','image',ARRAY['image-gen'],true)`,
    );
    const res = await app.request(`/admin/provider-keys/${id}`, {
      method: 'PATCH',
      headers: { authorization: `Bearer ${tok}`, 'content-type': 'application/json' },
      body: JSON.stringify({ protocol: 'anthropic' }),
    });
    expect(res.status).toBe(200);
    // The switch stays inside the chat family, so nothing is cleared at all.
    expect((await res.json() as { clearedModels?: number }).clearedModels).toBe(0);
    const other = await testPool.query<{ n: number }>(
      `SELECT count(*)::int n FROM model_catalog WHERE provider_key_id='pk-img'`);
    expect(other.rows[0].n).toBe(1);
  });

  // The media model list lives ONLY in model_catalog: an old cached console
  // bundle that still writes the legacy `config.models` field must be
  // accepted, and must not change the model list.
  test('写入 config.models 不会改动模型清单', async () => {
    const tok = await admin();
    await testPool.query(
      `INSERT INTO provider_keys(id,org_id,provider,protocol,enabled) VALUES ('pk-legacy','o1','minimax','image-gen',true)`,
    );
    await testPool.query(
      `INSERT INTO model_catalog(id, org_id, provider_key_id, provider, model, type, types, enabled)
       VALUES ('mc-legacy','o1','pk-legacy','minimax','image-01','image',ARRAY['image-gen'],true)`,
    );
    const res = await app.request('/admin/provider-keys/pk-legacy', {
      method: 'PATCH',
      headers: { authorization: `Bearer ${tok}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        config: { models: [{ modelId: 'other', displayName: 'other' }], limitSecondsToday: 600 },
      }),
    });
    expect(res.status).toBe(200);
    const rows = await testPool.query<{ model: string }>(
      `SELECT model FROM model_catalog WHERE provider_key_id='pk-legacy' ORDER BY model`);
    expect(rows.rows.map((r) => r.model)).toEqual(['image-01']);
    // The field is stripped from what is stored, and the other keys survive.
    const cfg = await testPool.query<{ config: Record<string, unknown> }>(
      `SELECT config FROM provider_keys WHERE id='pk-legacy'`);
    expect(cfg.rows[0].config.models).toBeUndefined();
    expect(cfg.rows[0].config.limitSecondsToday).toBe(600);
  });

  test('POST 的 config.models 也不会进入模型清单', async () => {
    const tok = await admin();
    const res = await app.request('/admin/provider-keys', {
      method: 'POST',
      headers: { authorization: `Bearer ${tok}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        orgId: 'o1',
        provider: 'minimax',
        protocol: 'image-gen',
        endpoint: 'https://api.minimaxi.com',
        config: { models: [{ modelId: 'image-99', displayName: 'image-99' }] },
      }),
    });
    expect(res.status).toBe(200);
    const { id } = (await res.json()) as { id: string };
    const rows = await testPool.query<{ n: number }>(
      `SELECT count(*)::int n FROM model_catalog WHERE provider_key_id=$1`, [id]);
    expect(rows.rows[0].n).toBe(0);
  });

  // A card holds at most one section per protocol: the console renders one
  // LLM chip with one protocol radio, so two `openai` sections on the same
  // card would be indistinguishable (and their model tables would collide).
  // The console adds a capability to an EXISTING card with a keyless POST
  // (the admin has not typed the key yet), then types the key and saves. A
  // keyless row is created disabled; setting its key must enable it, or the
  // section reports "saved" and routes nothing.
  test('给无密钥的分区补上密钥会把它启用', async () => {
    const tok = await admin();
    await testPool.query(
      `INSERT INTO provider_cards(id, org_id, provider) VALUES ('c-key','o1','kimi')`,
    );
    const created = await app.request('/admin/provider-keys', {
      method: 'POST',
      headers: { authorization: `Bearer ${tok}`, 'content-type': 'application/json' },
      body: JSON.stringify({ orgId: 'o1', cardId: 'c-key', provider: 'kimi', protocol: 'image-gen' }),
    });
    expect(created.status).toBe(200);
    const { id } = (await created.json()) as { id: string };
    const before = await testPool.query<{ enabled: boolean }>(
      `SELECT enabled FROM provider_keys WHERE id=$1`, [id]);
    expect(before.rows[0].enabled).toBe(false);

    const res = await app.request(`/admin/provider-keys/${id}`, {
      method: 'PATCH',
      headers: { authorization: `Bearer ${tok}`, 'content-type': 'application/json' },
      body: JSON.stringify({ apiKey: 'sk-kimi-1234' }),
    });
    expect(res.status).toBe(200);
    const after = await testPool.query<{ enabled: boolean }>(
      `SELECT enabled FROM provider_keys WHERE id=$1`, [id]);
    expect(after.rows[0].enabled).toBe(true);
  });

  // Switching the protocol of a section must honour the same invariant the
  // POST route enforces: one section per protocol per card. Otherwise the
  // console renders two indistinguishable LLM sections whose models shadow
  // each other.
  test('切换协议到同卡片已有的协议会被拒绝', async () => {
    const tok = await admin();
    await testPool.query(
      `INSERT INTO provider_cards(id, org_id, provider) VALUES ('c-sw','o1','kimi')`,
    );
    const first = await app.request('/admin/provider-keys', {
      method: 'POST',
      headers: { authorization: `Bearer ${tok}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        orgId: 'o1', cardId: 'c-sw', provider: 'kimi', protocol: 'openai',
      }),
    });
    const { id } = (await first.json()) as { id: string };
    const second = await app.request('/admin/provider-keys', {
      method: 'POST',
      headers: { authorization: `Bearer ${tok}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        orgId: 'o1', cardId: 'c-sw', provider: 'kimi', protocol: 'anthropic',
      }),
    });
    expect(second.status).toBe(200);
    await testPool.query(
      `INSERT INTO model_catalog(id, org_id, provider_key_id, provider, model, types)
       VALUES ('mc-sw','o1',$1,'kimi','kimi-k2',ARRAY['chat'])`, [id]);

    const res = await app.request(`/admin/provider-keys/${id}`, {
      method: 'PATCH',
      headers: { authorization: `Bearer ${tok}`, 'content-type': 'application/json' },
      body: JSON.stringify({ protocol: 'anthropic' }),
    });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: 'duplicate_section' });
    // Rejected before anything was written: the section keeps its models.
    const models = await testPool.query<{ n: number }>(
      `SELECT count(*)::int n FROM model_catalog WHERE provider_key_id=$1`, [id]);
    expect(models.rows[0].n).toBe(1);
  });

  test('同一张卡片下不能有两个同协议的分区', async () => {
    const tok = await admin();
    await testPool.query(
      `INSERT INTO provider_cards(id, org_id, provider) VALUES ('c-dup','o1','kimi')`,
    );
    const first = await app.request('/admin/provider-keys', {
      method: 'POST',
      headers: { authorization: `Bearer ${tok}`, 'content-type': 'application/json' },
      body: JSON.stringify({ orgId: 'o1', cardId: 'c-dup', provider: 'kimi', protocol: 'openai' }),
    });
    expect(first.status).toBe(200);
    const second = await app.request('/admin/provider-keys', {
      method: 'POST',
      headers: { authorization: `Bearer ${tok}`, 'content-type': 'application/json' },
      body: JSON.stringify({ orgId: 'o1', cardId: 'c-dup', provider: 'kimi', protocol: 'openai' }),
    });
    expect(second.status).toBe(409);
    expect(await second.json()).toEqual({ error: 'duplicate_section' });
    // A different protocol on the SAME card is the normal multi-capability case.
    const third = await app.request('/admin/provider-keys', {
      method: 'POST',
      headers: { authorization: `Bearer ${tok}`, 'content-type': 'application/json' },
      body: JSON.stringify({ orgId: 'o1', cardId: 'c-dup', provider: 'kimi', protocol: 'image-gen' }),
    });
    expect(third.status).toBe(200);
  });
});
