import '../helpers/setupEnv';

import { beforeEach, describe, expect, test, vi } from 'vitest';
vi.mock('../../src/db/pool', async () => {
  const td = await import('../../src/db/testDb');
  return { pool: td.testPool };
});
import { Hono } from 'hono';

import { signToken } from '../../src/auth/jwt';
import { resetSchema, runMigrations, testPool } from '../../src/db/testDb';
import { asrRoutes } from '../../src/routes/asr';

interface ModelsBody {
  code?: number;
  data?: Array<{ modelId?: string; displayName?: string; provider?: string; capabilities?: string[] }>;
  defaultModel?: string | null;
}

async function seed(): Promise<string> {
  await testPool.query(`INSERT INTO orgs(id,name,timezone) VALUES ('o1','T','UTC')`);
  await testPool.query(
    `INSERT INTO users(id, org_id, username, password_hash, status)
     VALUES ('u1','o1','u1','x','active')`,
  );
  await testPool.query(
    `INSERT INTO provider_keys(id,org_id,provider,created_by,protocol,enabled)
     VALUES ('pk1','o1','minimax','u1','realtime-asr',true)`,
  );
  await testPool.query(
    `INSERT INTO model_catalog(id, org_id, provider_key_id, provider, model, type, types, enabled)
     VALUES ('ma1','o1','pk1','minimax','asr-1.0','audio',ARRAY['asr'],true)`,
  );
  return signToken({ sub: 'u1', orgId: 'o1', roles: ['org_admin'] });
}

function app(): Hono {
  const a = new Hono();
  a.route('/', asrRoutes);
  return a;
}

describe('GET /api/asr/models', () => {
  beforeEach(async () => {
    await resetSchema();
    await runMigrations();
  });

  test('无 token → 401', async () => {
    expect((await app().request('/api/asr/models')).status).toBe(401);
  });

  test('列出 ASR 模型，带限定名和默认模型', async () => {
    const token = await seed();
    await testPool.query(
      `INSERT INTO model_type_defaults(org_id, type, model_id) VALUES ('o1','asr','ma1')`,
    );
    const res = await app().request('/api/asr/models', {
      headers: { authorization: `Bearer ${token}` },
    });
    const body = (await res.json()) as ModelsBody;
    expect(body.code).toBe(0);
    expect(body.data?.[0]?.modelId).toBe('minimax/asr-1.0');
    expect(body.data?.[0]?.capabilities).toEqual(['asr']);
    expect(body.defaultModel).toBe('minimax/asr-1.0');
  });

  test('没有模型时返回空清单', async () => {
    const token = await seed();
    await testPool.query(`DELETE FROM model_catalog`);
    const res = await app().request('/api/asr/models', {
      headers: { authorization: `Bearer ${token}` },
    });
    const body = (await res.json()) as ModelsBody;
    expect(body.code).toBe(0);
    expect(body.data).toEqual([]);
    expect(body.defaultModel).toBeNull();
  });
});
