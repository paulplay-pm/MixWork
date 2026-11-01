import '../helpers/setupEnv';

import { beforeEach, describe, expect, test, vi } from 'vitest';
vi.mock('../../src/db/pool', async () => {
  const td = await import('../../src/db/testDb');
  return { pool: td.testPool };
});
import { Hono } from 'hono';

import { signToken } from '../../src/auth/jwt';
import { _resetRequireActiveMemberCacheForTest } from '../../src/auth/requireActiveMember';
import { resetSchema, runMigrations, testPool } from '../../src/db/testDb';
import { asrRoutes, resolveAsrProvider } from '../../src/routes/asr';
import { encrypt } from '../../src/vault/crypto';

async function seedOrgUser(status = 'active'): Promise<string> {
  await testPool.query(`INSERT INTO orgs(id,name,timezone) VALUES ('o1','T','UTC')`);
  await testPool.query(
    `INSERT INTO users(id,org_id,username,password_hash,status)
     VALUES ('u1','o1','u1','x',$1)`,
    [status],
  );
  return signToken({ sub: 'u1', orgId: 'o1', roles: ['org_admin'] });
}

/** An enabled provider with the realtime-asr protocol. */
async function seedAsrProvider(
  id = 'pk1',
  opts: { protocol?: string; enabled?: boolean; config?: Record<string, unknown> } = {},
): Promise<void> {
  await testPool.query(
    `INSERT INTO provider_keys(id,org_id,provider,api_key_encrypted,created_by,protocol,enabled,config)
     VALUES ($1,'o1','minimax',$5,'u1',$2,$3,$4::jsonb)`,
    [
      id,
      opts.protocol ?? 'realtime-asr',
      opts.enabled ?? true,
      JSON.stringify(opts.config ?? {}),
      encrypt('sk-minimax-secret'),
    ],
  );
}

function app(): Hono {
  const a = new Hono();
  a.route('/', asrRoutes);
  return a;
}

/** The session endpoint's wire shape, narrowed from `Response.json()`. */
interface SessionBody {
  code?: number;
  error?: string;
  message?: string;
  data?: {
    requestId?: string;
    wsUrl?: string;
    expiresInSeconds?: number;
    chunkIntervalMillis?: number;
    maxSessionSeconds?: number;
    maxConcurrentSessions?: number;
    usedSecondsToday?: number;
    remainingSecondsToday?: number;
    limitSecondsToday?: number;
  };
}

const json = async (res: Response): Promise<SessionBody> => (await res.json()) as SessionBody;

const post = (token: string) =>
  app().request('/api/asr/realtime/sessions', {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/x-www-form-urlencoded' },
    body: 'langType=zh-CHS',
  });

describe('POST /api/asr/realtime/sessions', () => {
  beforeEach(async () => {
    await resetSchema();
    await runMigrations();
    // The member-status cache is keyed by user id and outlives a schema
    // reset; without this, the FIRST test's verdict (no user -> missing)
    // would be served to every later test as 'revoked'.
    _resetRequireActiveMemberCacheForTest();
  });

  test('无 token → 401', async () => {
    const res = await app().request('/api/asr/realtime/sessions', { method: 'POST' });
    expect(res.status).toBe(401);
  });

  test('被撤销的成员 → 401 且 body 带数字码 41602（桌面据此触发撤销）', async () => {
    const token = await seedOrgUser('disabled');
    const res = await post(token);
    expect(res.status).toBe(401);
    const body = await json(res);
    expect(body.code).toBe(41602);
    // 字符串形态保留，给读字符串的老客户端
    expect(body.error).toBe('not_member');
  });

  test('没有 ASR provider → code 41400 (ConfigInvalid)', async () => {
    const token = await seedOrgUser();
    const res = await post(token);
    expect(res.status).toBe(200);
    expect((await json(res)).code).toBe(41400);
  });

  test('protocol 合法但没有 ASR adapter（如 openai）→ 不被选中 → 41400', async () => {
    // The registry, not a literal in the route, decides what is ASR-capable.
    const token = await seedOrgUser();
    await seedAsrProvider('pk1', { protocol: 'openai' });
    const res = await post(token);
    expect((await json(res)).code).toBe(41400);
  });

  test('禁用的 provider 不参与选择', async () => {
    const token = await seedOrgUser();
    await seedAsrProvider('pk1', { enabled: false });
    const res = await post(token);
    expect((await json(res)).code).toBe(41400);
  });

  test('配额耗尽 → code 41404 (DailyLimitExceeded)', async () => {
    const token = await seedOrgUser();
    await seedAsrProvider('pk1', { config: { limitSecondsToday: 60 } });
    await testPool.query(
      `INSERT INTO asr_daily_usage(org_id,user_id,day,used_seconds) VALUES ('o1','u1',CURRENT_DATE,60)`,
    );
    const res = await post(token);
    expect((await json(res)).code).toBe(41404);
  });

  test('成功 → { code:0, data: AsrRealtimeSessionData }，含配额与 wsUrl', async () => {
    const token = await seedOrgUser();
    await seedAsrProvider('pk1', { config: { limitSecondsToday: 600 } });
    const res = await post(token);
    const body = await json(res);
    expect(body.code).toBe(0);
    expect(body.data?.requestId).toBeTruthy();
    expect(body.data?.wsUrl).toContain('/api/asr/realtime');
    expect(body.data?.limitSecondsToday).toBe(600);
    expect(body.data?.remainingSecondsToday).toBe(600);
    expect(body.data?.usedSecondsToday).toBe(0);
    expect(body.data?.chunkIntervalMillis).toBeGreaterThan(0);
    expect(body.data?.maxSessionSeconds).toBeGreaterThan(0);
  });

  test('请求体是 form-urlencoded（不是 JSON）', async () => {
    const token = await seedOrgUser();
    await seedAsrProvider('pk1');
    const res = await app().request('/api/asr/realtime/sessions', {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/x-www-form-urlencoded' },
      body: 'langType=zh-CHS',
    });
    expect((await json(res)).code).toBe(0);
  });

  test('已用配额计入 remaining', async () => {
    const token = await seedOrgUser();
    await seedAsrProvider('pk1', { config: { limitSecondsToday: 600 } });
    await testPool.query(
      `INSERT INTO asr_daily_usage(org_id,user_id,day,used_seconds) VALUES ('o1','u1',CURRENT_DATE,120)`,
    );
    const body = await json(await post(token));
    expect(body.data?.usedSecondsToday).toBe(120);
    expect(body.data?.remainingSecondsToday).toBe(480);
  });

  test('有默认 ASR 模型时，用默认模型所属的分区', async () => {
    await seedOrgUser();
    await seedAsrProvider('pk1');
    await seedAsrProvider('pk2');
    await testPool.query(
      `INSERT INTO model_catalog(id, org_id, provider_key_id, provider, model, type, types, enabled)
       VALUES ('ma1','o1','pk1','minimax','asr-1.0','audio',ARRAY['asr'],true),
              ('ma2','o1','pk2','kimi','kimi-asr','audio',ARRAY['asr'],true)`,
    );
    await testPool.query(
      `INSERT INTO model_type_defaults(org_id, type, model_id) VALUES ('o1','asr','ma2')`,
    );
    const resolved = await resolveAsrProvider('o1');
    expect(resolved?.row.id).toBe('pk2');
    // The BARE name: the adapter prefixes whatever its upstream expects.
    expect(resolved?.model).toBe('kimi-asr');
  });

  test('没有默认模型时用第一个启用的 asr 模型', async () => {
    await seedOrgUser();
    await seedAsrProvider('pk1');
    await seedAsrProvider('pk2');
    await testPool.query(
      `INSERT INTO model_catalog(id, org_id, provider_key_id, provider, model, type, types, enabled)
       VALUES ('ma2','o1','pk2','kimi','kimi-asr','audio',ARRAY['asr'],true)`,
    );
    const resolved = await resolveAsrProvider('o1');
    expect(resolved?.row.id).toBe('pk2');
    expect(resolved?.model).toBe('kimi-asr');
  });

  test('没有 catalog 行时退回最早的 ASR 分区，模型留空', async () => {
    await seedOrgUser();
    await seedAsrProvider('pk1');
    await seedAsrProvider('pk2');
    const resolved = await resolveAsrProvider('o1');
    expect(resolved?.row.id).toBe('pk1');
    expect(resolved?.model).toBeNull();
  });

  test('没有任何 ASR 分区时返回 null', async () => {
    await seedOrgUser();
    expect(await resolveAsrProvider('o1')).toBeNull();
  });
});
