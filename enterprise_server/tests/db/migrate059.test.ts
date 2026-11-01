import '../helpers/setupEnv';

import { beforeEach, describe, expect, test } from 'vitest';

import { resetSchema, runMigrations, testPool } from '../../src/db/testDb';

const MIGRATION_059 = '059_model_catalog_media.sql';

async function seedOrg(): Promise<void> {
  await testPool.query(`INSERT INTO orgs(id,name) VALUES ('o1','T') ON CONFLICT DO NOTHING`);
  await testPool.query(
    `INSERT INTO users(id,org_id,username,password_hash) VALUES ('u1','o1','u1','x') ON CONFLICT DO NOTHING`,
  );
}

async function seedKey(id: string, protocol: string, config: unknown): Promise<void> {
  await testPool.query(
    `INSERT INTO provider_keys(id, org_id, provider, protocol, config)
     VALUES ($1,'o1','minimax',$2,$3::jsonb)`,
    [id, protocol, JSON.stringify(config)],
  );
}

/**
 * Migrate to 058, seed the provider rows, THEN apply 059.
 *
 * 059 is a data migration: it lifts the media model lists out of
 * `provider_keys.config`, so it can only see the keys that existed when it
 * ran. Seeding afterwards would leave the catalog empty.
 */
async function migrateWithKeys(seed: () => Promise<void>): Promise<void> {
  await runMigrations({ exclude: [MIGRATION_059] });
  await seedOrg();
  await seed();
  await runMigrations();
}

describe('db/migrate 059 (media models into model_catalog + model_type_defaults)', () => {
  beforeEach(async () => {
    await resetSchema();
  });

  test('图像生成模型从 config.models 进入 model_catalog', async () => {
    await migrateWithKeys(async () => {
      await seedKey('k-img', 'image-gen', {
        models: [
          { modelId: 'image-01', displayName: 'image-01' },
          { modelId: 'image-01-live', displayName: 'live', parameterSpec: { size: '1024x1024' } },
        ],
      });
    });
    const r = await testPool.query<{ model: string; types: string[]; type: string; parameter_spec: unknown }>(
      `SELECT model, types, type, parameter_spec FROM model_catalog WHERE provider_key_id = 'k-img' ORDER BY model`,
    );
    expect(r.rows.map((x) => x.model)).toEqual(['image-01', 'image-01-live']);
    expect(r.rows[0].types).toEqual(['image-gen']);
    expect(r.rows[0].type).toBe('image');
    expect(r.rows[1].parameter_spec).toEqual({ size: '1024x1024' });
  });

  test('视频生成模型的 types 是 video-gen，legacy type 是 image', async () => {
    await migrateWithKeys(async () => {
      await seedKey('k-vid', 'video-gen', { models: [{ modelId: 'MiniMax-H3' }] });
    });
    const r = await testPool.query<{ types: string[]; type: string }>(
      `SELECT types, type FROM model_catalog WHERE provider_key_id = 'k-vid'`,
    );
    expect(r.rows[0].types).toEqual(['video-gen']);
    expect(r.rows[0].type).toBe('image');
  });

  test('语音识别分区补建默认模型行，并登记 asr 默认', async () => {
    await migrateWithKeys(async () => {
      await seedKey('k-asr', 'realtime-asr', {});
    });
    const m = await testPool.query<{ id: string; model: string; types: string[] }>(
      `SELECT id, model, types FROM model_catalog WHERE provider_key_id = 'k-asr'`,
    );
    expect(m.rows).toHaveLength(1);
    expect(m.rows[0].model).toBe('asr-1.0');
    expect(m.rows[0].types).toEqual(['asr']);
    const d = await testPool.query<{ type: string; model_id: string }>(
      `SELECT type, model_id FROM model_type_defaults WHERE org_id = 'o1'`,
    );
    expect(d.rows).toEqual([{ type: 'asr', model_id: m.rows[0].id }]);
  });

  test('config.model 指定了别的模型名时按它建行', async () => {
    await migrateWithKeys(async () => {
      await seedKey('k-asr', 'realtime-asr', { model: 'asr-2.0' });
    });
    const m = await testPool.query<{ model: string }>(
      `SELECT model FROM model_catalog WHERE provider_key_id = 'k-asr'`,
    );
    expect(m.rows[0].model).toBe('asr-2.0');
  });

  test('空 modelId 的条目被跳过', async () => {
    await migrateWithKeys(async () => {
      await seedKey('k-img', 'image-gen', { models: [{ modelId: '' }, { modelId: 'image-01' }] });
    });
    const r = await testPool.query<{ model: string }>(
      `SELECT model FROM model_catalog WHERE provider_key_id = 'k-img'`,
    );
    expect(r.rows.map(x => x.model)).toEqual(['image-01']);
  });

  test('config 里没有 models 的分区不产生模型行', async () => {
    await migrateWithKeys(async () => {
      // `config` is NOT NULL with a '{}' default, so "no models" is an empty
      // object rather than a NULL — `config->'models'` is then NULL and has
      // to coalesce to an empty array before jsonb_array_elements sees it.
      await testPool.query(
        `INSERT INTO provider_keys(id, org_id, provider, protocol, config)
         VALUES ('k-null','o1','minimax','image-gen','{}'::jsonb)`,
      );
    });
    const r = await testPool.query<{ n: number }>(`SELECT count(*)::int AS n FROM model_catalog`);
    expect(r.rows[0].n).toBe(0);
  });

  test('一个类型只能有一个默认（主键约束）', async () => {
    await runMigrations();
    await seedOrg();
    await testPool.query(
      `INSERT INTO provider_keys(id, org_id, provider, protocol) VALUES ('k-x','o1','minimax','image-gen')`,
    );
    await testPool.query(
      `INSERT INTO model_catalog(id, org_id, provider_key_id, provider, model, types)
       VALUES ('m1','o1','k-x','minimax','a',ARRAY['image-gen']),
              ('m2','o1','k-x','minimax','b',ARRAY['image-gen'])`,
    );
    await testPool.query(
      `INSERT INTO model_type_defaults(org_id, type, model_id) VALUES ('o1','image-gen','m1')`,
    );
    await expect(
      testPool.query(
        `INSERT INTO model_type_defaults(org_id, type, model_id) VALUES ('o1','image-gen','m2')`,
      ),
    ).rejects.toThrow();
  });

  test('重复执行不报错（幂等）', async () => {
    await migrateWithKeys(async () => {
      await seedKey('k-img', 'image-gen', { models: [{ modelId: 'image-01' }] });
    });
    await runMigrations();
    const r = await testPool.query<{ n: number }>(`SELECT count(*)::int AS n FROM model_catalog`);
    expect(r.rows[0].n).toBe(1);
  });

  test('已应用 058 的旧库，补跑 059 后媒体模型才出现', async () => {
    await runMigrations({ exclude: [MIGRATION_059] });
    await seedOrg();
    await seedKey('k-img', 'image-gen', { models: [{ modelId: 'image-01' }] });
    const before = await testPool.query<{ n: number }>(`SELECT count(*)::int AS n FROM model_catalog`);
    expect(before.rows[0].n).toBe(0);
    await runMigrations();
    const after = await testPool.query<{ n: number }>(`SELECT count(*)::int AS n FROM model_catalog`);
    expect(after.rows[0].n).toBe(1);
  });
});
