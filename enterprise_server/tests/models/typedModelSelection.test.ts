import '../helpers/setupEnv';

import { beforeEach, describe, expect, test, vi } from 'vitest';

vi.mock('../../src/db/pool', async () => {
  const td = await import('../../src/db/testDb');
  return { pool: td.testPool };
});

import { resetSchema, runMigrations, testPool } from '../../src/db/testDb';
import { typedModelSelection } from '../../src/models/typedModelSelection';

async function seed(): Promise<void> {
  await testPool.query(`INSERT INTO orgs(id,name) VALUES ('o1','T') ON CONFLICT DO NOTHING`);
  await testPool.query(
    `INSERT INTO users(id,org_id,username,password_hash) VALUES ('u1','o1','u1','x') ON CONFLICT DO NOTHING`,
  );
}

/** A provider key, optionally attached to a card. */
async function seedKey(
  id: string,
  provider: string,
  protocol: string,
  opts: { cardId?: string; enabled?: boolean; createdAt?: string } = {},
): Promise<void> {
  await testPool.query(
    `INSERT INTO provider_keys(id, org_id, provider, protocol, card_id, enabled, created_at)
     VALUES ($1,'o1',$2,$3,$4,$5,COALESCE($6::timestamptz, now()))`,
    [id, provider, protocol, opts.cardId ?? null, opts.enabled ?? true, opts.createdAt ?? null],
  );
}

async function seedModel(
  id: string,
  keyId: string,
  model: string,
  types: string[],
  opts: { enabled?: boolean; createdAt?: string } = {},
): Promise<void> {
  await testPool.query(
    `INSERT INTO model_catalog(id, org_id, provider_key_id, provider, model, types, enabled, created_at)
     VALUES ($1,'o1',$2,'minimax',$3,$4::text[],$5,COALESCE($6::timestamptz, now()))`,
    [id, keyId, model, types, opts.enabled ?? true, opts.createdAt ?? null],
  );
}

describe('models/typedModelSelection', () => {
  beforeEach(async () => {
    await resetSchema();
    await runMigrations();
    await seed();
  });

  test('列出该类型下已启用的模型，限定名带厂商前缀', async () => {
    await seedKey('k1', 'minimax', 'image-gen');
    await seedModel('m1', 'k1', 'image-01', ['image-gen']);
    const list = await typedModelSelection.listCandidates('o1', 'image-gen');
    expect(list).toHaveLength(1);
    expect(list[0].qualifiedId).toBe('minimax/image-01');
    expect(list[0].model).toBe('image-01');
    expect(list[0].providerKeyId).toBe('k1');
  });

  test('分区被停用时模型不出现', async () => {
    await seedKey('k1', 'minimax', 'image-gen', { enabled: false });
    await seedModel('m1', 'k1', 'image-01', ['image-gen']);
    expect(await typedModelSelection.listCandidates('o1', 'image-gen')).toEqual([]);
  });

  test('模型本身被停用时不出现在清单里', async () => {
    await seedKey('k1', 'minimax', 'image-gen');
    await seedModel('m1', 'k1', 'image-01', ['image-gen'], { enabled: false });
    expect(await typedModelSelection.listCandidates('o1', 'image-gen')).toEqual([]);
  });

  test('被策略停用的模型不出现', async () => {
    await seedKey('k1', 'minimax', 'image-gen');
    await seedModel('m1', 'k1', 'image-01', ['image-gen']);
    await testPool.query(
      `INSERT INTO model_policies(id, org_id, model_id, disabled, created_by)
       VALUES ('pol1','o1','m1',true,'u1')`,
    );
    expect(await typedModelSelection.listCandidates('o1', 'image-gen')).toEqual([]);
  });

  test('类型不匹配的模型不出现', async () => {
    await seedKey('k1', 'minimax', 'image-gen');
    await seedModel('m1', 'k1', 'image-01', ['video-gen']);
    expect(await typedModelSelection.listCandidates('o1', 'image-gen')).toEqual([]);
  });

  test('显式指定限定名 → explicit', async () => {
    await seedKey('k1', 'minimax', 'image-gen');
    await seedModel('m1', 'k1', 'image-01', ['image-gen']);
    const sel = await typedModelSelection.select('o1', 'image-gen', 'minimax/image-01');
    expect(sel?.reason).toBe('explicit');
    expect(sel?.candidate.id).toBe('m1');
  });

  test('显式指定裸名且唯一命中 → explicit', async () => {
    await seedKey('k1', 'minimax', 'image-gen');
    await seedModel('m1', 'k1', 'image-01', ['image-gen']);
    const sel = await typedModelSelection.select('o1', 'image-gen', 'image-01');
    expect(sel?.reason).toBe('explicit');
    expect(sel?.candidate.id).toBe('m1');
  });

  test('裸名命中多行 → 回退到默认模型，reason=ambiguous_fallback', async () => {
    await seedKey('k1', 'minimax', 'image-gen');
    await seedKey('k2', 'kimi', 'image-gen');
    await seedModel('m1', 'k1', 'image-01', ['image-gen']);
    await seedModel('m2', 'k2', 'image-01', ['image-gen']);
    await testPool.query(
      `INSERT INTO model_type_defaults(org_id, type, model_id) VALUES ('o1','image-gen','m2')`,
    );
    const sel = await typedModelSelection.select('o1', 'image-gen', 'image-01');
    expect(sel?.reason).toBe('ambiguous_fallback');
    expect(sel?.candidate.id).toBe('m2');
  });

  test('裸名命中多行且没有默认 → 落到第一个启用的模型', async () => {
    await seedKey('k1', 'minimax', 'image-gen');
    await seedKey('k2', 'kimi', 'image-gen');
    await seedModel('m1', 'k1', 'image-01', ['image-gen'], { createdAt: '2026-01-01' });
    await seedModel('m2', 'k2', 'image-01', ['image-gen'], { createdAt: '2026-02-01' });
    const sel = await typedModelSelection.select('o1', 'image-gen', 'image-01');
    expect(sel?.reason).toBe('ambiguous_fallback');
    expect(sel?.candidate.id).toBe('m1');
  });

  test('模型不存在 → 回退到默认模型，reason=not_found_fallback', async () => {
    await seedKey('k1', 'minimax', 'image-gen');
    await seedModel('m1', 'k1', 'image-01', ['image-gen']);
    await testPool.query(
      `INSERT INTO model_type_defaults(org_id, type, model_id) VALUES ('o1','image-gen','m1')`,
    );
    const sel = await typedModelSelection.select('o1', 'image-gen', 'nope');
    expect(sel?.reason).toBe('not_found_fallback');
    expect(sel?.candidate.id).toBe('m1');
  });

  test('没有指定模型 → 用默认模型，reason=default', async () => {
    await seedKey('k1', 'minimax', 'image-gen');
    await seedModel('m1', 'k1', 'image-01', ['image-gen']);
    await seedModel('m2', 'k1', 'image-02', ['image-gen'], { createdAt: '2026-02-01' });
    await testPool.query(
      `INSERT INTO model_type_defaults(org_id, type, model_id) VALUES ('o1','image-gen','m2')`,
    );
    const sel = await typedModelSelection.select('o1', 'image-gen', undefined);
    expect(sel?.reason).toBe('default');
    expect(sel?.candidate.id).toBe('m2');
  });

  test('没有指定模型也没有默认 → 第一个启用的模型', async () => {
    await seedKey('k1', 'minimax', 'image-gen');
    await seedModel('m1', 'k1', 'image-01', ['image-gen'], { createdAt: '2026-01-01' });
    await seedModel('m2', 'k1', 'image-02', ['image-gen'], { createdAt: '2026-02-01' });
    const sel = await typedModelSelection.select('o1', 'image-gen', '');
    expect(sel?.reason).toBe('default');
    expect(sel?.candidate.id).toBe('m1');
  });

  test('被停用的默认模型不算默认，退回第一个启用的模型', async () => {
    await seedKey('k1', 'minimax', 'image-gen');
    await seedModel('m1', 'k1', 'image-01', ['image-gen'], { createdAt: '2026-01-01' });
    await seedModel('m2', 'k1', 'image-02', ['image-gen'], { createdAt: '2026-02-01' });
    await testPool.query(
      `INSERT INTO model_type_defaults(org_id, type, model_id) VALUES ('o1','image-gen','m2')`,
    );
    await testPool.query(`UPDATE model_catalog SET enabled = false WHERE id = 'm2'`);
    const sel = await typedModelSelection.select('o1', 'image-gen', undefined);
    expect(sel?.candidate.id).toBe('m1');
  });

  test('卡片有显示名时限定名用显示名', async () => {
    await testPool.query(
      `INSERT INTO provider_cards(id, org_id, provider, label) VALUES ('c1','o1','minimax','MiniMax 图像')`,
    );
    await seedKey('k1', 'minimax', 'image-gen', { cardId: 'c1' });
    await seedModel('m1', 'k1', 'image-01', ['image-gen']);
    const list = await typedModelSelection.listCandidates('o1', 'image-gen');
    expect(list[0].qualifiedId).toBe('MiniMax 图像/image-01');
  });

  test('没有任何启用模型时 select 返回 null', async () => {
    expect(await typedModelSelection.select('o1', 'image-gen', 'image-01')).toBeNull();
  });

  // Review Focus 1: a card renamed after the client cached the old name. The
  // stale qualified name must not 500 and must not silently pick some other
  // model: the bare part still matches exactly one row, so the request lands
  // on the model the client meant. The reason stays `explicit` — the client
  // named this model and the server found it; only the cached PREFIX was
  // stale, which is not a model-selection fallback.
  test('卡片改名后客户端仍发旧限定名 → 仍落到裸名匹配的模型', async () => {
    await testPool.query(
      `INSERT INTO provider_cards(id, org_id, provider, label) VALUES ('c1','o1','minimax','新名字')`,
    );
    await seedKey('k1', 'minimax', 'image-gen', { cardId: 'c1' });
    await seedModel('m1', 'k1', 'image-01', ['image-gen']);
    const sel = await typedModelSelection.select('o1', 'image-gen', '旧名字/image-01');
    expect(sel?.reason).toBe('explicit');
    expect(sel?.candidate.id).toBe('m1');
  });

  // Review Focus 3: a disabled provider key is an org-wide off switch — its
  // models must not be selectable even though the catalog row says enabled.
  test('分区被停用时该模型不可作为默认被选中', async () => {
    await seedKey('k1', 'minimax', 'image-gen');
    await seedModel('m1', 'k1', 'image-01', ['image-gen']);
    await testPool.query(
      `INSERT INTO model_type_defaults(org_id, type, model_id) VALUES ('o1','image-gen','m1')`,
    );
    await testPool.query(`UPDATE provider_keys SET enabled = false WHERE id = 'k1'`);
    expect(await typedModelSelection.select('o1', 'image-gen', undefined)).toBeNull();
  });
});
