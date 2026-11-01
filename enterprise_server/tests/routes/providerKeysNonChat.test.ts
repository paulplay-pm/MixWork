import '../helpers/setupEnv';

import { beforeEach, describe, expect, test, vi } from 'vitest';

vi.mock('../../src/db/pool', async () => {
  const td = await import('../../src/db/testDb');
  return { pool: td.testPool };
});

import { Hono } from 'hono';

import { authService } from '../../src/auth/authService';
import { signToken } from '../../src/auth/jwt';
import { resetSchema, runMigrations, testPool } from '../../src/db/testDb';
import { adminProviderKeyRoutes } from '../../src/routes/admin/providerKeys';
import { authRoutes } from '../../src/routes/auth';

const app = new Hono();
app.route('/', authRoutes);
app.route('/', adminProviderKeyRoutes);

async function seedAdmin(): Promise<{ token: string }> {
  await testPool.query(`INSERT INTO orgs(id,name) VALUES ('o1', 'T')`);
  const u = await authService.createUser({
    orgId: 'o1',
    username: 'admin',
    password: 'pw12345678',
  });
  const token = await signToken({ sub: u.id, orgId: 'o1', roles: ['super_admin'] });
  return { token };
}

/**
 * The console creates the ASR / image / video providers through the same
 * admin route as the chat ones — one provider row, one protocol. These tests
 * cover the two things that route has to get right for a non-chat row: the
 * protocol is stored as sent, and `config` keeps carrying the row's non-model
 * settings while the media model list lives in `model_catalog` (migration 059
 * moved it there; `config.models` is stripped on write).
 */
describe('admin/provider-keys non-chat protocols', () => {
  beforeEach(async () => {
    await resetSchema();
    await runMigrations();
  });

  test('POST creates an image provider with its protocol, not a config model list', async () => {
    const { token } = await seedAdmin();
    const res = await app.request('/admin/provider-keys', {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        orgId: 'o1',
        provider: 'custom-1',
        label: 'minimax-image',
        endpoint: 'https://api.minimaxi.com',
        apiKey: 'sk-minimax',
        protocol: 'image-gen',
        config: {
          models: [{ modelId: 'image-01', displayName: 'image-01' }],
          limitSecondsToday: 600,
        },
      }),
    });
    expect(res.status).toBe(200);
    const row = await testPool.query<{ id: string; protocol: string; config: Record<string, unknown>; enabled: boolean }>(
      `SELECT id, protocol, config, enabled FROM provider_keys WHERE org_id='o1'`,
    );
    expect(row.rows[0].protocol).toBe('image-gen');
    // The media model list belongs to `model_catalog`; a `config.models`
    // payload is dropped, and the other settings survive.
    expect(row.rows[0].config).toEqual({ limitSecondsToday: 600 });
    // A keyed provider starts enabled — the media route only looks at
    // enabled rows.
    expect(row.rows[0].enabled).toBe(true);
  });

  test('PATCH merges the stored config but drops its model list', async () => {
    const { token } = await seedAdmin();
    const created = await app.request('/admin/provider-keys', {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        orgId: 'o1',
        provider: 'custom-1',
        endpoint: 'https://api.minimaxi.com',
        apiKey: 'sk-minimax',
        protocol: 'image-gen',
      }),
    });
    const { id } = (await created.json()) as { id: string };

    const res = await app.request(`/admin/provider-keys/${id}`, {
      method: 'PATCH',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        config: { models: [{ modelId: 'image-01' }], limitSecondsToday: 900 },
      }),
    });
    expect(res.status).toBe(200);
    const row = await testPool.query<{ config: Record<string, unknown> }>(
      `SELECT config FROM provider_keys WHERE id=$1`, [id]);
    expect(row.rows[0].config).toEqual({ limitSecondsToday: 900 });
  });

  test('GET echoes the config settings so the console can edit them', async () => {
    const { token } = await seedAdmin();
    const created = await app.request('/admin/provider-keys', {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        orgId: 'o1',
        provider: 'custom-1',
        endpoint: 'https://api.minimaxi.com',
        apiKey: 'sk-minimax',
        protocol: 'video-gen',
        config: { models: [{ modelId: 'MiniMax-H3' }], limitSecondsToday: 300 },
      }),
    });
    const { id } = (await created.json()) as { id: string };

    const res = await app.request('/admin/provider-keys?orgId=o1', {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(200);
    const rows = (await res.json()) as {
      id: string;
      protocol: string;
      config: Record<string, unknown>;
    }[];
    const row = rows.find((r) => r.id === id);
    expect(row?.protocol).toBe('video-gen');
    expect(row?.config).toEqual({ limitSecondsToday: 300 });
  });

  test('an unknown protocol is rejected', async () => {
    const { token } = await seedAdmin();
    const res = await app.request('/admin/provider-keys', {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        orgId: 'o1',
        provider: 'custom-1',
        protocol: 'not-a-protocol',
      }),
    });
    expect(res.status).toBe(400);
  });
});
