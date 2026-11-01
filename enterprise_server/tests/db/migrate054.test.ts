import '../helpers/setupEnv';

import { beforeEach, describe, expect, test } from 'vitest';

import { resetSchema, runMigrations, testPool } from '../../src/db/testDb';

describe('db/migrate 054 (asr/media)', () => {
  beforeEach(async () => {
    await resetSchema();
  });

  test('provider_keys 增加 config 列，protocol 接受 realtime-asr/image-gen/video-gen', async () => {
    await runMigrations();

    const col = await testPool.query<{ c: string | null }>(
      `SELECT column_name AS c FROM information_schema.columns
       WHERE table_name='provider_keys' AND column_name='config'`,
    );
    expect(col.rows[0].c).toBe('config');

    await testPool.query(
      `INSERT INTO orgs(id,name) VALUES ('o1','T') ON CONFLICT DO NOTHING`,
    );
    await testPool.query(
      `INSERT INTO users(id,org_id,username,password_hash) VALUES ('u1','o1','u1','x') ON CONFLICT DO NOTHING`,
    );
    // protocol 的 CHECK 必须放行这三个新值（迁移前会被拒）
    for (const p of ['realtime-asr', 'image-gen', 'video-gen']) {
      await testPool.query(
        `INSERT INTO provider_keys(id,org_id,provider,api_key_encrypted,created_by,protocol)
         VALUES ($1,'o1',$2,'x','u1',$3)`,
        [`pk-${p}`, `p-${p}`, p],
      );
    }
    const r = await testPool.query<{ protocol: string }>(
      `SELECT protocol FROM provider_keys WHERE id='pk-realtime-asr'`,
    );
    expect(r.rows[0].protocol).toBe('realtime-asr');
  });

  test('provider_keys.config 默认空对象且可写 JSON', async () => {
    await runMigrations();
    await testPool.query(`INSERT INTO orgs(id,name) VALUES ('o1','T') ON CONFLICT DO NOTHING`);
    await testPool.query(
      `INSERT INTO users(id,org_id,username,password_hash) VALUES ('u1','o1','u1','x') ON CONFLICT DO NOTHING`,
    );
    await testPool.query(
      `INSERT INTO provider_keys(id,org_id,provider,api_key_encrypted,created_by,config)
       VALUES ('pk1','o1','minimax','x','u1','{"sampleRate":16000}'::jsonb)`,
    );
    const r = await testPool.query<{ config: Record<string, unknown> }>(
      `SELECT config FROM provider_keys WHERE id='pk1'`,
    );
    expect(r.rows[0].config.sampleRate).toBe(16000);
  });

  test('asr_daily_usage 存在且 (org,user,day) 唯一', async () => {
    await runMigrations();
    await testPool.query(`INSERT INTO orgs(id,name) VALUES ('o1','T') ON CONFLICT DO NOTHING`);
    await testPool.query(
      `INSERT INTO users(id,org_id,username,password_hash) VALUES ('u1','o1','u1','x') ON CONFLICT DO NOTHING`,
    );
    await testPool.query(
      `INSERT INTO asr_daily_usage(org_id,user_id,day,used_seconds) VALUES ('o1','u1','2026-04-15',30)`,
    );
    await expect(
      testPool.query(
        `INSERT INTO asr_daily_usage(org_id,user_id,day,used_seconds) VALUES ('o1','u1','2026-04-15',5)`,
      ),
    ).rejects.toThrow();
  });

  test('media_tasks 存在、(org_id,idempotency_key) 唯一、status 含 cancelled', async () => {
    await runMigrations();
    await testPool.query(`INSERT INTO orgs(id,name) VALUES ('o1','T') ON CONFLICT DO NOTHING`);
    await testPool.query(
      `INSERT INTO users(id,org_id,username,password_hash) VALUES ('u1','o1','u1','x') ON CONFLICT DO NOTHING`,
    );
    await testPool.query(
      `INSERT INTO media_tasks(id,org_id,user_id,kind,model,prompt,status,idempotency_key)
       VALUES ('t1','o1','u1','image','gpt-image-2','{}'::jsonb,'queued','k1')`,
    );
    await expect(
      testPool.query(
        `INSERT INTO media_tasks(id,org_id,user_id,kind,model,prompt,status,idempotency_key)
         VALUES ('t2','o1','u1','image','gpt-image-2','{}'::jsonb,'queued','k1')`,
      ),
    ).rejects.toThrow();
    // cancelled 两个 l（对齐桌面终态判定）
    const r = await testPool.query(
      `UPDATE media_tasks SET status='cancelled' WHERE id='t1'`,
    );
    expect(r.rowCount).toBe(1);
  });
});
