import '../helpers/setupEnv';

import { beforeEach, describe, expect, test, vi } from 'vitest';

vi.mock('../../src/db/pool', async () => {
  const td = await import('../../src/db/testDb');
  return { pool: td.testPool };
});

import { resetSchema, runMigrations, testPool } from '../../src/db/testDb';
import { modelTypeDefaults } from '../../src/models/modelTypeDefaults';

describe('models/modelTypeDefaults', () => {
  beforeEach(async () => {
    await resetSchema();
    await runMigrations();
    await testPool.query(`INSERT INTO orgs(id,name) VALUES ('o1','T') ON CONFLICT DO NOTHING`);
    await testPool.query(
      `INSERT INTO users(id,org_id,username,password_hash) VALUES ('u1','o1','u1','x') ON CONFLICT DO NOTHING`,
    );
    await testPool.query(
      `INSERT INTO provider_keys(id, org_id, provider, protocol) VALUES ('k1','o1','minimax','image-gen')`,
    );
    await testPool.query(
      `INSERT INTO model_catalog(id, org_id, provider_key_id, provider, model, types)
       VALUES ('m1','o1','k1','minimax','a',ARRAY['image-gen']),
              ('m2','o1','k1','minimax','b',ARRAY['image-gen'])`,
    );
  });

  test('默认可以设置和读取', async () => {
    await modelTypeDefaults.set('o1', 'image-gen', 'm1');
    expect(await modelTypeDefaults.get('o1', 'image-gen')).toBe('m1');
  });

  test('同一类型再设一次会替换掉旧的', async () => {
    await modelTypeDefaults.set('o1', 'image-gen', 'm1');
    await modelTypeDefaults.set('o1', 'image-gen', 'm2');
    expect(await modelTypeDefaults.get('o1', 'image-gen')).toBe('m2');
  });

  test('清除后没有默认', async () => {
    await modelTypeDefaults.set('o1', 'image-gen', 'm1');
    await modelTypeDefaults.clear('o1', 'image-gen');
    expect(await modelTypeDefaults.get('o1', 'image-gen')).toBeNull();
  });

  test('不同类型各有各的默认', async () => {
    await modelTypeDefaults.set('o1', 'image-gen', 'm1');
    await modelTypeDefaults.set('o1', 'video-gen', 'm2');
    expect(await modelTypeDefaults.get('o1', 'image-gen')).toBe('m1');
    expect(await modelTypeDefaults.get('o1', 'video-gen')).toBe('m2');
  });

  test('删除模型会连带清掉默认', async () => {
    await modelTypeDefaults.set('o1', 'image-gen', 'm1');
    await testPool.query(`DELETE FROM model_catalog WHERE id = 'm1'`);
    expect(await modelTypeDefaults.get('o1', 'image-gen')).toBeNull();
  });

  test('listForOrg 列出本组织的全部默认', async () => {
    await modelTypeDefaults.set('o1', 'image-gen', 'm1');
    await modelTypeDefaults.set('o1', 'video-gen', 'm2');
    expect(await modelTypeDefaults.listForOrg('o1')).toEqual([
      { type: 'image-gen', modelId: 'm1' },
      { type: 'video-gen', modelId: 'm2' },
    ]);
  });

  test('默认不跨组织泄漏', async () => {
    await testPool.query(`INSERT INTO orgs(id,name) VALUES ('o2','T2') ON CONFLICT DO NOTHING`);
    await modelTypeDefaults.set('o1', 'image-gen', 'm1');
    expect(await modelTypeDefaults.get('o2', 'image-gen')).toBeNull();
    expect(await modelTypeDefaults.listForOrg('o2')).toEqual([]);
  });
});
