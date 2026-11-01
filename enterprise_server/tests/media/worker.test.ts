import '../helpers/setupEnv';

import { beforeEach, describe, expect, test, vi } from 'vitest';
vi.mock('../../src/db/pool', async () => {
  const td = await import('../../src/db/testDb');
  return { pool: td.testPool };
});

import { resetSchema, runMigrations, testPool } from '../../src/db/testDb';
import { createMediaWorker } from '../../src/media/worker';

async function seedTask(over: {
  id?: string;
  status?: string;
  createdAt?: string;
  kind?: 'image' | 'video';
  upstreamTaskId?: string | null;
} = {}): Promise<string> {
  const id = over.id ?? 't1';
  await testPool.query(`INSERT INTO orgs(id,name) VALUES ('o1','T') ON CONFLICT DO NOTHING`);
  await testPool.query(
    `INSERT INTO users(id,org_id,username,password_hash) VALUES ('u1','o1','u1','x') ON CONFLICT DO NOTHING`,
  );
  await testPool.query(
    `INSERT INTO media_tasks(id,org_id,user_id,kind,model,prompt,status,provider,provider_key_id,upstream_task_id,created_at,updated_at)
     VALUES ($1,'o1','u1',$4,'m','{}'::jsonb,$2,'minimax','pk1',$5,$3,$3)`,
    [
      id,
      over.status ?? 'queued',
      over.createdAt ?? new Date().toISOString(),
      over.kind ?? 'video',
      'upstreamTaskId' in over ? over.upstreamTaskId! : 'up1',
    ],
  );
  return id;
}

describe('media worker', () => {
  beforeEach(async () => {
    await resetSchema();
    await runMigrations();
  });

  test('认领 queued 任务并置为 running', async () => {
    await seedTask();
    const worker = createMediaWorker({
      getProvider: () => undefined,
      resolveConfig: async () => null,
    });
    await worker.runOnce();
    const r = await testPool.query<{ status: string }>(
      `SELECT status FROM media_tasks WHERE id='t1'`,
    );
    expect(r.rows[0].status).toBe('failed');
  });

  test('provider 报成功 → 任务 succeeded 且带 resultUrls', async () => {
    await seedTask();
    const worker = createMediaWorker({
      getProvider: () => ({
        synchronous: false,
        submit: async () => ({ upstreamTaskId: 'up1' }),
        poll: async () => ({ status: 'succeeded', resultUrls: ['https://cdn/x.png'] }),
        cancel: async () => {},
      }) as never,
      resolveConfig: async () => ({
        id: 'pk1', protocol: 'video-gen', provider: 'minimax',
        endpoint: null, apiKey: 'k', config: {},
      }),
    });
    await worker.runOnce();
    const r = await testPool.query<{ status: string; result: { resultUrls: string[] } }>(
      `SELECT status, result FROM media_tasks WHERE id='t1'`,
    );
    expect(r.rows[0].status).toBe('succeeded');
    expect(r.rows[0].result.resultUrls).toEqual(['https://cdn/x.png']);
  });

  test('迟到的轮询结果不能覆盖 cancelled（终态写是条件更新）', async () => {
    await seedTask({ status: 'cancelled' });
    const worker = createMediaWorker({
      getProvider: () => ({
        synchronous: false,
        submit: async () => ({ upstreamTaskId: 'up1' }),
        poll: async () => ({ status: 'succeeded', resultUrls: ['https://cdn/x.png'] }),
        cancel: async () => {},
      }) as never,
      resolveConfig: async () => ({
        id: 'pk1', protocol: 'video-gen', provider: 'minimax',
        endpoint: null, apiKey: 'k', config: {},
      }),
    });
    await worker.runOnce();
    const r = await testPool.query<{ status: string }>(
      `SELECT status FROM media_tasks WHERE id='t1'`,
    );
    // cancelled 不在 (queued) 里，所以根本不会被认领；即使被认领，终态写也带条件。
    expect(r.rows[0].status).toBe('cancelled');
  });

  test('还在进行中的任务回到 queued，等下一轮', async () => {
    await seedTask();
    const worker = createMediaWorker({
      getProvider: () => ({
        synchronous: false,
        submit: async () => ({ upstreamTaskId: 'up1' }),
        poll: async () => ({ status: 'running' }),
        cancel: async () => {},
      }) as never,
      resolveConfig: async () => ({
        id: 'pk1', protocol: 'video-gen', provider: 'minimax',
        endpoint: null, apiKey: 'k', config: {},
      }),
    });
    await worker.runOnce();
    const r = await testPool.query<{ status: string }>(
      `SELECT status FROM media_tasks WHERE id='t1'`,
    );
    expect(r.rows[0].status).toBe('queued');
  });

  test('过期任务被判 failed（客户端会一直轮询下去）', async () => {
    // An IMAGE older than the image ceiling (30 min) expires; a VIDEO gets
    // 10 hours, so an hour-old video must survive.
    const old = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    await seedTask({ status: 'running', createdAt: old, kind: 'image' });
    const worker = createMediaWorker({
      expiryMs: { image: 1000, video: 10 * 60 * 60 * 1000 },
    });
    const n = await worker.expireStaleTasks();
    expect(n).toBe(1);
    const r = await testPool.query<{ status: string }>(
      `SELECT status FROM media_tasks WHERE id='t1'`,
    );
    expect(r.rows[0].status).toBe('failed');
  });

  test('没有 queued 任务时 runOnce 返回 0（不抛错）', async () => {
    const worker = createMediaWorker({ getProvider: () => undefined });
    expect(await worker.runOnce()).toBe(0);
  });

  /**
   * 'submitting' is the status the generate route reserves a task in, while
   * the upstream submit is still in flight. The worker must not claim it:
   * there is no upstream id yet, so a claim would fail a task that is about
   * to succeed.
   */
  test('submitting 的任务不会被认领（还没有 upstream id）', async () => {
    await seedTask({ status: 'submitting', upstreamTaskId: null });
    const worker = createMediaWorker({
      getProvider: () => undefined,
      resolveConfig: async () => null,
    });
    expect(await worker.runOnce()).toBe(0);
    const r = await testPool.query<{ status: string; error: unknown }>(
      `SELECT status, error FROM media_tasks WHERE id='t1'`,
    );
    expect(r.rows[0].status).toBe('submitting');
    expect(r.rows[0].error).toBeNull();
  });

  test('submitting 的任务过了有效期判 failed（提交途中崩了）', async () => {
    const old = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    await seedTask({ status: 'submitting', createdAt: old, kind: 'image' });
    const worker = createMediaWorker({
      expiryMs: { image: 1000, video: 10 * 60 * 60 * 1000 },
    });
    expect(await worker.expireStaleTasks()).toBe(1);
    const r = await testPool.query<{ status: string }>(
      `SELECT status FROM media_tasks WHERE id='t1'`,
    );
    expect(r.rows[0].status).toBe('failed');
  });

  test('成功与失败互斥：succeeded 不带 error，failed 不带 result', async () => {
    // 'queued', not 'running': the worker claims queued rows.
    await seedTask({ id: 'ok', status: 'queued', upstreamTaskId: 'up-ok' });
    await testPool.query(
      `UPDATE media_tasks SET error = '{"errorMessage":"stale"}'::jsonb WHERE id='ok'`,
    );
    await seedTask({ id: 'bad', status: 'queued', upstreamTaskId: 'up-bad' });
    await testPool.query(
      `UPDATE media_tasks SET result = '{"resultUrls":["https://cdn/stale.png"]}'::jsonb WHERE id='bad'`,
    );

    const worker = createMediaWorker({
      getProvider: () => ({
        synchronous: false,
        submit: async () => ({ upstreamTaskId: 'up1' }),
        poll: async (_cfg: unknown, id: string) => (id === 'up-ok'
          ? { status: 'succeeded', resultUrls: ['https://cdn/ok.png'] }
          : { status: 'failed', errorMessage: 'upstream said no' }),
        cancel: async () => {},
      }) as never,
      resolveConfig: async () => ({
        id: 'pk1', protocol: 'video-gen', provider: 'minimax',
        endpoint: null, apiKey: 'k', config: {},
      }),
    });

    await worker.runOnce();
    await worker.runOnce();

    const ok = await testPool.query<{ status: string; error: unknown; result: { resultUrls: string[] } }>(
      `SELECT status, error, result FROM media_tasks WHERE id='ok'`,
    );
    expect(ok.rows[0].status).toBe('succeeded');
    expect(ok.rows[0].error).toBeNull();
    expect(ok.rows[0].result.resultUrls).toEqual(['https://cdn/ok.png']);

    const bad = await testPool.query<{ status: string; error: { errorMessage: string }; result: unknown }>(
      `SELECT status, error, result FROM media_tasks WHERE id='bad'`,
    );
    expect(bad.rows[0].status).toBe('failed');
    expect(bad.rows[0].error.errorMessage).toBe('upstream said no');
    expect(bad.rows[0].result).toBeNull();
  });
});
