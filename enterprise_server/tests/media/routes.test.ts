import '../helpers/setupEnv';

import { beforeEach, describe, expect, test, vi } from 'vitest';
vi.mock('../../src/db/pool', async () => {
  const td = await import('../../src/db/testDb');
  return { pool: td.testPool };
});
import { Hono } from 'hono';

import { signToken } from '../../src/auth/jwt';
import { resetSchema, runMigrations, testPool } from '../../src/db/testDb';
import { mediaRoutes } from '../../src/routes/media';
import { encrypt } from '../../src/vault/crypto';

async function seed(): Promise<string> {
  await testPool.query(`INSERT INTO orgs(id,name,timezone) VALUES ('o1','T','UTC')`);
  await testPool.query(`INSERT INTO orgs(id,name,timezone) VALUES ('o2','Other','UTC')`);
  await testPool.query(
    `INSERT INTO users(id, org_id, username, password_hash, status)
     VALUES ('u1','o1','u1','x','active'), ('u2','o2','u2','x','active')`,
  );
  await testPool.query(
    `INSERT INTO provider_keys(id,org_id,provider,api_key_encrypted,created_by,protocol,enabled,config)
     VALUES ('pk1','o1','minimax',$1,'u1','image-gen',true,'{"models":[{"modelId":"gpt-image-2","displayName":"GPT Image 2"}]}'::jsonb),
            ('pk2','o1','minimax',$1,'u1','video-gen',true,'{"models":[{"modelId":"happyhorse-1.1-t2v","displayName":"HappyHorse 1.1"}]}'::jsonb)`,
    [encrypt('sk-minimax')],
  );
  // The catalog is what the model list and the routing read. The legacy
  // `config.models` fields above stay because the console writes them until
  // P1 replaces that field; the list no longer reads them.
  await testPool.query(
    `INSERT INTO model_catalog(id, org_id, provider_key_id, provider, model, display_name, type, types, enabled)
     VALUES ('mc1','o1','pk1','minimax','gpt-image-2','GPT Image 2','image',ARRAY['image-gen'],true),
            ('mc2','o1','pk2','minimax','happyhorse-1.1-t2v','HappyHorse 1.1','image',ARRAY['video-gen'],true)`,
  );
  return signToken({ sub: 'u1', orgId: 'o1', roles: ['org_admin'] });
}

/**
 * A second image-gen vendor whose key and model are created LATER than the
 * seeded MiniMax ones. The old route took the earliest key, so a request for
 * this vendor's model is only routed correctly by model ownership.
 */
async function seedTwoVendors(): Promise<string> {
  const token = await seed();
  await testPool.query(
    `INSERT INTO provider_keys(id,org_id,provider,api_key_encrypted,created_by,protocol,enabled,config,created_at)
     VALUES ('pk-kimi','o1','kimi',$1,'u1','image-gen',true,'{}'::jsonb, now() + interval '1 day')`,
    [encrypt('sk-kimi')],
  );
  await testPool.query(
    `INSERT INTO model_catalog(id, org_id, provider_key_id, provider, model, display_name, type, types, enabled, created_at)
     VALUES ('mc-kimi','o1','pk-kimi','kimi','kimi-image-01','Kimi Image','image',ARRAY['image-gen'],true, now() + interval '1 day')`,
  );
  return token;
}

/** The wire shapes this endpoint speaks. */
interface ModelDescriptor {
  modelId?: string;
  displayName?: string;
  provider?: string;
  capabilities?: string[];
  parameterSpec?: Record<string, unknown>;
}

interface TaskData {
  taskId?: string;
  upstreamTaskId?: string;
  status?: string;
  model?: string;
  upstreamModel?: string;
  resultUrls?: string[];
  errorMessage?: string;
  modelSelectionReason?: string;
  quotaRemaining?: number | null;
  metadata?: { execution_expires_after?: number | null };
}

/** `Response.json()` is `unknown`; the tests read specific shapes. */
const json = async <T>(res: Response): Promise<T> => (await res.json()) as T;

interface Envelope<T> {
  code?: number;
  message?: string;
  data?: T;
  defaultModel?: string | null;
}

function app(): Hono {
  const a = new Hono();
  a.route('/', mediaRoutes);
  return a;
}

const post = (token: string, path: string, body: unknown, headers: Record<string, string> = {}) =>
  app().request(path, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });

describe('media routes', () => {
  beforeEach(async () => {
    await resetSchema();
    await runMigrations();
  });

  test('无 token → 401', async () => {
    const res = await app().request('/api/media/images/models');
    expect(res.status).toBe(401);
  });

  test('列模型 → { code:0, data:[{modelId,displayName,capabilities,parameterSpec}] }', async () => {
    const token = await seed();
    const res = await app().request('/api/media/images/models', {
      headers: { authorization: `Bearer ${token}` },
    });
    const body = await json<Envelope<ModelDescriptor[]>>(res);
    expect(body.code).toBe(0);
    expect(Array.isArray(body.data)).toBe(true);
    // 数据来自 model_catalog，模型名带厂商限定名
    expect(body.data?.[0]?.modelId).toBe('minimax/gpt-image-2');
    expect(body.data?.[0]?.displayName).toBe('GPT Image 2');
    expect(body.data?.[0]).toHaveProperty('capabilities');
    expect(body.data?.[0]).toHaveProperty('parameterSpec');
  });

  test('列模型来自 model_catalog，且带厂商限定名', async () => {
    const token = await seed();
    const list = await json<Envelope<ModelDescriptor[]>>(
      await app().request('/api/media/images/models', { headers: { authorization: `Bearer ${token}` } }),
    );
    expect(list.code).toBe(0);
    expect(list.data?.[0]?.modelId).toBe('minimax/gpt-image-2');
    expect(list.data?.[0]?.provider).toBe('minimax');
    expect(list.data?.[0]?.capabilities).toEqual(['image-gen']);
  });

  test('列模型带出该类型的默认模型', async () => {
    const token = await seed();
    await testPool.query(
      `INSERT INTO model_type_defaults(org_id, type, model_id)
       SELECT 'o1','image-gen', id FROM model_catalog WHERE model = 'gpt-image-2'`,
    );
    const res = await app().request('/api/media/images/models', {
      headers: { authorization: `Bearer ${token}` },
    });
    const body = await json<{ data?: unknown[]; defaultModel?: string }>(res);
    expect(body.defaultModel).toBe('minimax/gpt-image-2');
  });

  // "This org has no image models" is a normal state, not an error: the old
  // endpoint answered code 41400, which the desktop could only render as a
  // failure.
  test('没有可用媒体模型时返回空清单，不是错误', async () => {
    const token = await seed();
    await testPool.query(`DELETE FROM model_catalog WHERE id = 'mc1'`);
    const res = await app().request('/api/media/images/models', {
      headers: { authorization: `Bearer ${token}` },
    });
    const body = await json<{ code?: number; data?: unknown[]; defaultModel?: string | null }>(res);
    expect(body.code).toBe(0);
    expect(body.data).toEqual([]);
    expect(body.defaultModel).toBeNull();
  });

  test('建任务 → data 含 taskId/status/model/upstreamTaskId/metadata.execution_expires_after', async () => {
    const token = await seed();
    const res = await post(token, '/api/media/images/generate', {
      model: 'gpt-image-2', type: 'image', prompt: 'a cat', params: {},
    });
    const body = await json<Envelope<TaskData>>(res);
    expect(body.code).toBe(0);
    expect(body.data?.taskId).toBeTruthy();
    expect(body.data?.status).toBeTruthy();
    // The stored model is the client's identity for it: the QUALIFIED id.
    expect(body.data?.model).toBe('minimax/gpt-image-2');
    expect(body.data).toHaveProperty('upstreamTaskId');
    expect(body.data).toHaveProperty('quotaRemaining');
    expect(body.data?.metadata).toHaveProperty('execution_expires_after');
  });

  test('建任务带 Idempotency-Key 时重复请求返回同一个任务', async () => {
    const token = await seed();
    const first = await post(token, '/api/media/images/generate',
      { model: 'gpt-image-2', type: 'image', prompt: 'cat', params: {} },
      { 'idempotency-key': 'k1' });
    const second = await post(token, '/api/media/images/generate',
      { model: 'gpt-image-2', type: 'image', prompt: 'cat', params: {} },
      { 'idempotency-key': 'k1' });
    const a = await json<Envelope<TaskData>>(first);
    const b = await json<Envelope<TaskData>>(second);
    expect(a.data?.taskId).toBe(b.data?.taskId);
  });

  test('状态 → data 含 status/resultUrls/errorMessage', async () => {
    const token = await seed();
    const created = await json<Envelope<TaskData>>(await post(token, '/api/media/images/generate',
      { model: 'gpt-image-2', type: 'image', prompt: 'cat', params: {} }));
    const res = await app().request(`/api/media/images/tasks/${created.data?.taskId}`, {
      headers: { authorization: `Bearer ${token}` },
    });
    const body = await json<Envelope<TaskData>>(res);
    expect(body.code).toBe(0);
    expect(body.data).toHaveProperty('status');
    expect(body.data).toHaveProperty('resultUrls');
    expect(body.data).toHaveProperty('errorMessage');
  });

  test('终态拼写是 cancelled（两个 l）—— 写错桌面端会永远轮询', async () => {
    const token = await seed();
    const created = await json<Envelope<TaskData>>(await post(token, '/api/media/images/generate',
      { model: 'gpt-image-2', type: 'image', prompt: 'cat', params: {} }));
    await testPool.query(`UPDATE media_tasks SET status='cancelled' WHERE id=$1`, [created.data?.taskId]);
    const res = await app().request(`/api/media/images/tasks/${created.data?.taskId}`, {
      headers: { authorization: `Bearer ${token}` },
    });
    const body = await json<Envelope<TaskData>>(res);
    expect(body.data?.status).toBe('cancelled');
    expect(['succeeded', 'failed', 'cancelled']).toContain(body.data?.status);
  });

  test('组织隔离：另一个组织的任务读不到', async () => {
    const token = await seed();
    const created = await json<Envelope<TaskData>>(await post(token, '/api/media/images/generate',
      { model: 'gpt-image-2', type: 'image', prompt: 'cat', params: {} }));
    const otherToken = await signToken({ sub: 'u2', orgId: 'o2', roles: ['org_admin'] });
    const res = await app().request(`/api/media/images/tasks/${created.data?.taskId}`, {
      headers: { authorization: `Bearer ${otherToken}` },
    });
    expect(res.status).toBe(404);
  });

  test('取消一个 pending 任务 → 状态变 cancelled', async () => {
    const token = await seed();
    const created = await json<Envelope<TaskData>>(await post(token, '/api/media/videos/generate',
      { model: 'happyhorse-1.1-t2v', type: 't2v', prompt: 'cat', params: {} }));
    // Put it in the state a real ASYNC upstream would leave it in. (The
    // Minimax adapter is a skeleton, so a real submit fails and the task lands
    // `failed` — and cancelling an already-terminal task is a no-op, covered
    // separately below.)
    await testPool.query(`UPDATE media_tasks SET status='queued' WHERE id=$1`, [created.data?.taskId]);
    const res = await post(token, `/api/media/videos/tasks/${created.data?.taskId}/cancel`, {});
    expect(res.status).toBe(200);
    const after = await json<Envelope<TaskData>>(await app().request(`/api/media/videos/tasks/${created.data?.taskId}`, {
      headers: { authorization: `Bearer ${token}` },
    }));
    expect(after.data?.status).toBe('cancelled');
  });

  test('取消一个已终态的任务是 no-op，不是错误（桌面端可能先轮询再取消）', async () => {
    const token = await seed();
    const created = await json<Envelope<TaskData>>(await post(token, '/api/media/videos/generate',
      { model: 'happyhorse-1.1-t2v', type: 't2v', prompt: 'cat', params: {} }));
    const res = await post(token, `/api/media/videos/tasks/${created.data?.taskId}/cancel`, {});
    expect(res.status).toBe(200);
    expect((await json<Envelope<TaskData>>(res)).data?.status).toBe('failed');
  });
  test('两个厂商都开了图像生成时，请求的模型决定走哪家', async () => {
    const token = await seedTwoVendors();
    const res = await post(token, '/api/media/images/generate', {
      model: 'kimi/kimi-image-01', type: 'image', prompt: 'cat', params: {},
    });
    expect(res.status).toBe(200);
    const task = await testPool.query<{ provider_key_id: string }>(
      `SELECT provider_key_id FROM media_tasks WHERE id = $1`,
      [(await json<Envelope<TaskData>>(res)).data?.taskId],
    );
    // NOT the earliest-created key — the key that owns the requested model.
    expect(task.rows[0].provider_key_id).toBe('pk-kimi');
  });

  test('模型不存在时回退到默认模型，并在 result 里写明原因', async () => {
    const token = await seedTwoVendors();
    await testPool.query(
      `INSERT INTO model_type_defaults(org_id, type, model_id)
       SELECT 'o1','image-gen', id FROM model_catalog WHERE model = 'kimi-image-01'`,
    );
    const res = await post(token, '/api/media/images/generate', {
      model: 'does-not-exist', type: 'image', prompt: 'cat', params: {},
    });
    const body = await json<Envelope<TaskData>>(res);
    expect(body.code).toBe(0);
    expect(body.data?.modelSelectionReason).toBe('not_found_fallback');
    expect(body.data?.upstreamModel).toBe('kimi-image-01');
  });

  test('不指定模型时用该类型的默认模型', async () => {
    const token = await seedTwoVendors();
    await testPool.query(
      `INSERT INTO model_type_defaults(org_id, type, model_id)
       SELECT 'o1','image-gen', id FROM model_catalog WHERE model = 'kimi-image-01'`,
    );
    const res = await post(token, '/api/media/images/generate', {
      type: 'image', prompt: 'cat', params: {},
    });
    const body = await json<Envelope<TaskData>>(res);
    expect(body.code).toBe(0);
    expect(body.data?.modelSelectionReason).toBe('default');
    expect(body.data?.upstreamModel).toBe('kimi-image-01');
  });

  test('没有任何启用模型时返回 400 no_provider_configured', async () => {
    const token = await seed();
    await testPool.query(`UPDATE model_catalog SET enabled = false`);
    const res = await post(token, '/api/media/images/generate', {
      model: 'gpt-image-2', type: 'image', prompt: 'cat', params: {},
    });
    expect(res.status).toBe(400);
    expect((await json<Envelope<TaskData>>(res)).message).toBe('no_provider_configured');
  });
});
