import '../helpers/setupEnv';

import { beforeEach, describe, expect, test, vi } from 'vitest';

vi.mock('../../src/db/pool', async () => {
  const td = await import('../../src/db/testDb');
  return { pool: td.testPool };
});

import { resetSchema, runMigrations, testPool } from '../../src/db/testDb';
import {
  BUILTIN_PROVIDERS,
  legacyTypeFor,
  seedBuiltinProviders,
  seedBuiltinProvidersForAllOrgs,
} from '../../src/org/builtinProviders';

describe('builtin provider seed', () => {
  beforeEach(async () => {
    await resetSchema();
    await runMigrations();
    await testPool.query(`INSERT INTO orgs(id,name) VALUES ('o1','A'), ('o2','B')`);
  });

  test('exposes exactly 9 built-in providers', () => {
    expect(BUILTIN_PROVIDERS).toHaveLength(9);
    expect(BUILTIN_PROVIDERS.map((p) => p.slug).sort()).toEqual(
      ['anthropic', 'deepseek', 'minimax', 'moonshot', 'openai', 'qwen', 'volc', 'xiaomi', 'zhipu'].sort(),
    );
  });

  test('seeds the PRD-matched OpenAI-compatible Base URLs', () => {
    // The seeded (default OpenAI-protocol) endpoints match the reference UI /
    // PRD §provider table. Pins the domain/path fixes (MiniMax → minimaxi.com,
    // Qwen → /compatible-mode/v1, Xiaomi → full /v1/chat/completions path).
    const bySlug = Object.fromEntries(BUILTIN_PROVIDERS.map((p) => [p.slug, p.endpoint]));
    expect(bySlug.deepseek).toBe('https://api.deepseek.com');
    expect(bySlug.moonshot).toBe('https://api.moonshot.cn/v1');
    expect(bySlug.qwen).toBe('https://dashscope.aliyuncs.com/compatible-mode/v1');
    expect(bySlug.zhipu).toBe('https://open.bigmodel.cn/api/paas/v4');
    expect(bySlug.minimax).toBe('https://api.minimaxi.com/v1');
    expect(bySlug.xiaomi).toBe('https://api.xiaomimimo.com/v1/chat/completions');
    expect(bySlug.volc).toBe('https://ark.cn-beijing.volces.com/api/v3');
  });

  // The legacy single-value `type` column must not call a video model a chat
  // model: older desktop contracts read that column, and the console's chat
  // pickers would then offer a video model.
  test('video-gen 模型的旧类型列是 image', () => {
    expect(legacyTypeFor(['video-gen'])).toBe('image');
  });

  test('seeds 9 builtins + their models for an org, idempotently', async () => {
    await seedBuiltinProviders('o1');
    await seedBuiltinProviders('o1'); // re-seed must be a no-op
    const pk = await testPool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM provider_keys WHERE org_id='o1' AND is_builtin`,
    );
    expect(pk.rows[0].n).toBe(9);
    const mc = await testPool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM model_catalog WHERE org_id='o1'`,
    );
    const expectedModels = BUILTIN_PROVIDERS.reduce((s, p) => s + p.models.length, 0);
    expect(mc.rows[0].n).toBe(expectedModels);
    // A seeded builtin has no key and no creator, and starts DISABLED (a
    // keyless provider cannot authenticate; the operator adds a key + enables).
    const oai = await testPool.query<{
      api_key_encrypted: string | null;
      created_by: string | null;
      enabled: boolean;
    }>(
      `SELECT api_key_encrypted, created_by, enabled FROM provider_keys WHERE org_id='o1' AND provider='openai' AND is_builtin`,
    );
    expect(oai.rows[0].api_key_encrypted).toBeNull();
    expect(oai.rows[0].created_by).toBeNull();
    expect(oai.rows[0].enabled).toBe(false);
    // Seeded models carry a types array and a legal legacy type.
    const m = await testPool.query<{ types: string[]; type: string }>(
      `SELECT types, type FROM model_catalog WHERE org_id='o1' AND model='gpt-4o'`,
    );
    expect(m.rows[0].types).toEqual(['chat', 'vision']);
    expect(m.rows[0].type).toBe('chat');
  });

  test('内置 provider 会带上自己的卡片', async () => {
    await seedBuiltinProviders('o1');
    const r = await testPool.query<{ card_id: string | null; card_provider: string | null }>(
      `SELECT k.card_id, c.provider AS card_provider
         FROM provider_keys k LEFT JOIN provider_cards c ON c.id = k.card_id
        WHERE k.id = 'builtin:o1:minimax'`,
    );
    expect(r.rows[0].card_id).toBe('builtin:card:o1:minimax');
    expect(r.rows[0].card_provider).toBe('minimax');
  });

  test('每个内置 provider 都有自己的卡片', async () => {
    await seedBuiltinProviders('o1');
    const r = await testPool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM provider_cards WHERE org_id='o1'`,
    );
    expect(r.rows[0].n).toBe(BUILTIN_PROVIDERS.length);
  });

  test('重复播种不改变卡片的归属', async () => {
    await seedBuiltinProviders('o1');
    await seedBuiltinProviders('o1');
    const r = await testPool.query<{ card_id: string | null }>(
      `SELECT card_id FROM provider_keys WHERE id = 'builtin:o1:minimax'`,
    );
    expect(r.rows[0].card_id).toBe('builtin:card:o1:minimax');
    const c = await testPool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM provider_cards WHERE org_id='o1'`,
    );
    expect(c.rows[0].n).toBe(BUILTIN_PROVIDERS.length);
  });

  test('厂商已有默认卡片时，内置密钥复用它而不是再建一张', async () => {
    // An org seeded before the card migration already owns a card for the
    // vendor (the 058 backfill made one). The seed must reuse it — the card
    // PREFIX is unique per org, so a second card with the same prefix would
    // be rejected.
    await testPool.query(
      `INSERT INTO provider_cards(id, org_id, provider) VALUES ('card:legacy','o1','minimax')`,
    );
    await seedBuiltinProviders('o1');
    const r = await testPool.query<{ card_id: string | null }>(
      `SELECT card_id FROM provider_keys WHERE id = 'builtin:o1:minimax'`,
    );
    expect(r.rows[0].card_id).toBe('card:legacy');
  });

  test('backfills all orgs', async () => {
    await seedBuiltinProvidersForAllOrgs();
    for (const o of ['o1', 'o2']) {
      const pk = await testPool.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM provider_keys WHERE org_id='${o}' AND is_builtin`,
      );
      expect(pk.rows[0].n).toBe(9);
    }
  });
});
