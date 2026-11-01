import '../helpers/setupEnv';

import { beforeEach, describe, expect, test, vi } from 'vitest';
vi.mock('../../src/db/pool', async () => {
  const td = await import('../../src/db/testDb');
  return { pool: td.testPool };
});
import { Hono } from 'hono';

import { queryModels, type UsageModelRow } from '../../src/analytics/usage';
import { authService } from '../../src/auth/authService';
import { signToken } from '../../src/auth/jwt';
import { resetSchema, runMigrations, testPool } from '../../src/db/testDb';

/** Shape of the `/admin/usage/models` listing body. */
interface ModelsBody {
  total: number;
  items: UsageModelRow[];
}

const FROM = new Date('2026-03-01T00:00:00Z');
const TO = new Date('2026-03-08T00:00:00Z');

// Captured in beforeEach: provider_keys.created_by and token_usage.user_id
// both reference users(id) NOT NULL, so we must use the UUID authService
// returns rather than the literal 'u1' the brief proposed.
let userId: string;

/** Seed one model_catalog row. Tests use this explicitly before any
 * `usage()` call so the FK on token_usage.model_id (NO ACTION default, no
 * ON DELETE) is exercised honestly. The bare `usage()` helper does NOT
 * call seedCatalog implicitly; conflating "the id resolves" with "the
 * catalog has this model" was an earlier mistake that broke the boundary
 * test by polluting it with zero-total catalog-only rows. */
async function seedCatalog(
  model: string,
  opts?: { modelId?: string; providerKeyId?: string; displayName?: string; provider?: string },
): Promise<string> {
  const id = opts?.modelId ?? `mc:${model}`;
  const keyId = opts?.providerKeyId ?? 'pk1';
  await testPool.query(
    `INSERT INTO model_catalog(id, org_id, provider_key_id, provider, model, display_name)
     VALUES ($1, 'o1', $2, $3, $4, $5)
     ON CONFLICT (org_id, provider_key_id, model) DO NOTHING`,
    [id, keyId, opts?.provider ?? 'anthropic', model, opts?.displayName ?? model],
  );
  return id;
}

/** Insert one token_usage row. The caller MUST have seeded a matching
 * model_catalog row first, or this helper surfaces the FK constraint
 * violation directly — that is the intended discipline, not a failure
 * mode. The pre-test FK assertion pins the contract so a future edit that
 * drops the constraint fails the suite loudly. */
async function usage(
  provider: string,
  model: string,
  tokens: number,
  opts?: { modelId?: string; missing?: boolean; ts?: string },
): Promise<void> {
  const modelId = opts?.modelId ?? `mc:${model}`;
  await testPool.query(
    `INSERT INTO token_usage(org_id,user_id,model_id,provider,token_in,token_out,total_tokens,result_code,quota_window_date,usage_missing,ts)
     VALUES ('o1',$1,$2,$3,$4,$4,$4*2,200,'2026-03-01',$5,$6)`,
    [userId, modelId, provider, tokens, opts?.missing ?? false, opts?.ts ?? '2026-03-01T10:00:00Z'],
  );
}

describe('queryModels', () => {
  beforeEach(async () => {
    await resetSchema(); await runMigrations();
    await testPool.query(`INSERT INTO orgs(id,name) VALUES ('o1','T')`);
    const u = await authService.createUser({ orgId: 'o1', username: 'a', password: 'pw12345' });
    userId = u.id;
    await testPool.query(
      `INSERT INTO provider_keys(id,org_id,provider,api_key_encrypted,created_by) VALUES ('pk1','o1','anthropic','x',$1)`,
      [userId],
    );
  });

  test('the FK on token_usage.model_id is present after runMigrations()', async () => {
    // Sanity check that the rest of the suite implicitly relies on. A
    // bare INSERT against a non-existent model_id MUST fail with SQLSTATE
    // 23503; if the FK has been silently dropped (by a refactor or a
    // tooling mishap), the orphan-row tests below would still pass, but
    // they would pass against a schema state production never sees.
    const r = testPool.query(
      `INSERT INTO token_usage(org_id,user_id,model_id,provider,token_in,token_out,total_tokens,result_code,quota_window_date)
       VALUES ('o1',$1,'no-such-model','anthropic',1,1,2,200,'2026-03-01')`,
      [userId],
    );
    await expect(r).rejects.toThrow();
    // Even more explicitly: assert the constraint by name so this test
    // points straight at the column we care about.
    const c = await testPool.query<{ conname: string }>(
      `SELECT conname FROM pg_constraint
       WHERE conrelid = 'token_usage'::regclass AND contype = 'f'
         AND pg_get_constraintdef(oid) LIKE '%model_catalog%'`,
    );
    expect(c.rows.map((row) => row.conname)).toContain('token_usage_model_id_fkey');
  });

  test('same-named models under two provider keys merge into one row with summed tokens', async () => {
    // Brief mistake to flag: both rows under the same provider_key_id ('pk1')
    // would collide on migration 039's (org_id, provider_key_id, model) unique
    // index. Seed a SECOND provider_key so the brief's demo (built-in key vs
    // custom key for the same vendor) is structurally honest.
    await testPool.query(
      `INSERT INTO provider_keys(id,org_id,provider,api_key_encrypted,created_by) VALUES ('pk2','o1','anthropic','y',$1)`,
      [userId],
    );
    await testPool.query(
      `INSERT INTO model_catalog(id,org_id,provider_key_id,provider,model,display_name) VALUES
       ('builtin:o1:anthropic:opus','o1','pk1','anthropic','opus','Claude Opus'),
       ('custom-uuid','o1','pk2','anthropic','opus','Claude Opus')`);
    await usage('anthropic', 'opus', 100, { modelId: 'builtin:o1:anthropic:opus' });
    await usage('anthropic', 'opus', 250, { modelId: 'custom-uuid' });

    const r = await queryModels({ orgId: 'o1', from: FROM, to: TO, page: 1, pageSize: 50 });
    expect(r.items).toHaveLength(1);
    expect(r.items[0]).toMatchObject({ provider: 'anthropic', model: 'opus', display_name: 'Claude Opus', total_tokens: 700, call_count: 2 });
  });

  test('a catalog model with no calls in range still appears at zero', async () => {
    await testPool.query(
      `INSERT INTO model_catalog(id,org_id,provider_key_id,provider,model,display_name)
       VALUES ('builtin:o1:anthropic:sonnet','o1','pk1','anthropic','sonnet','Claude Sonnet')`);
    const r = await queryModels({ orgId: 'o1', from: FROM, to: TO, page: 1, pageSize: 50 });
    expect(r.items).toEqual([
      { provider: 'anthropic', model: 'sonnet', display_name: 'Claude Sonnet', total_tokens: 0, call_count: 0 },
    ]);
  });

  test('a hard-deleted catalog row with zero usage simply vanishes (FK permits it)', async () => {
    // This is the only "deletion" outcome the live FK actually allows:
    // NO ACTION forbids removing a parent that has live child rows, so
    // any catalog row that DOES get deleted must have zero usage at the
    // moment of deletion — and it then has no history to keep.
    await seedCatalog('ghost', { modelId: 'gone-id', displayName: 'Ghost' });
    // No usage rows for 'gone-id' on purpose. The DELETE will succeed
    // because the FK has no children to block.
    await testPool.query(`DELETE FROM model_catalog WHERE id='gone-id'`);
    const r = await queryModels({ orgId: 'o1', from: FROM, to: TO, page: 1, pageSize: 50 });
    expect(r.items.find((i) => i.model === 'ghost')).toBeUndefined();
  });

  test('a hard-deleted catalog row with live usage rows is BLOCKED by the FK', async () => {
    // Companion to the previous test: a catalog row that HAS usage rows
    // cannot be hard-deleted at all — the FK (NO ACTION) raises 23503.
    // This is what makes the "history survives deletion" property
    // mechanically true without the query needing a special path: there
    // is no orphan row in the first place. Covering it via the actual
    // modelCatalog.remove (which just runs DELETE FROM model_catalog)
    // makes the contract auditable.
    await seedCatalog('live', { modelId: 'live-id', displayName: 'Live' });
    await usage('anthropic', 'live', 100, { modelId: 'live-id' });
    const del = testPool.query(`DELETE FROM model_catalog WHERE id='live-id'`);
    await expect(del).rejects.toThrow();
    // And the model still shows in the page with its tokens intact.
    const r = await queryModels({ orgId: 'o1', from: FROM, to: TO, page: 1, pageSize: 50 });
    expect(r.items.find((i) => i.model === 'live')).toMatchObject({ model: 'live', total_tokens: 200 });
  });

  test('editing display_name on a configured model updates the page label after the fact', async () => {
    // The catalog side aggregates display_name independently (MAX, not
    // GROUP BY), so a later patch that edits only the label flows through
    // to the page immediately — the usage side's GROUP BY key is the
    // unpatched `model` column, so the row does not split. This is the
    // real drift surface in the schema, and the reachable case.
    await seedCatalog('opus', { displayName: 'Old Name' });
    await usage('anthropic', 'opus', 50);
    await testPool.query(`UPDATE model_catalog SET display_name='New Name' WHERE model='opus'`);
    const r = await queryModels({ orgId: 'o1', from: FROM, to: TO, page: 1, pageSize: 50 });
    const row = r.items.find((i) => i.model === 'opus');
    expect(row).toBeDefined();
    expect(row!.display_name).toBe('New Name');
    expect(row!.total_tokens).toBe(100); // 50 * 2
    expect(r.items).toHaveLength(1); // no split into "old name" + "new name"
  });

  test('rows outside [from, to) are excluded', async () => {
    // Three usage rows: one before FROM, one at the exclusive TO bound, one
    // inside. Only the in-window row seeds a catalog row; the other two
    // belong to the catalog_agg side as well, but we want them absent
    // from the page. The honest way to express that is to keep their
    // usage rows AND their catalog rows, and assert that the FULL JOIN
    // still surfaces them at zero — confirming that "uncalled catalog
    // model shows at 0" applies to models whose usage is outside the
    // window, which is the same shape as the "no calls in range" PRD
    // requirement.
    await seedCatalog('a');
    await seedCatalog('b');
    await seedCatalog('c');
    await usage('anthropic', 'a', 10, { ts: '2026-02-28T23:00:00Z' });
    await usage('anthropic', 'b', 10, { ts: '2026-03-08T00:00:00Z' });
    await usage('anthropic', 'c', 10, { ts: '2026-03-07T23:00:00Z' });
    const r = await queryModels({ orgId: 'o1', from: FROM, to: TO, page: 1, pageSize: 50 });
    // All three catalog rows survive in the FULL JOIN, but only 'c' has
    // usage-side tokens; 'a' and 'b' are at zero. The half-open window
    // is doing its job on the usage side; the catalog side is untouched
    // (we want configured-but-unused models to stay visible).
    const rows = r.items.sort((x, y) => x.model.localeCompare(y.model));
    expect(rows).toEqual([
      { provider: 'anthropic', model: 'a', display_name: 'a', total_tokens: 0, call_count: 0 },
      { provider: 'anthropic', model: 'b', display_name: 'b', total_tokens: 0, call_count: 0 },
      { provider: 'anthropic', model: 'c', display_name: 'c', total_tokens: 20, call_count: 1 },
    ]);
  });

  test('another org is never visible', async () => {
    // Seed a usage row for o1 so we have something to keep.
    await seedCatalog('x');
    await usage('anthropic', 'x', 10, { ts: '2026-03-02T10:00:00Z' });
    // Build the full chain for o2 so the FK is honestly exercised on
    // both sides — a half-built o2 chain would surface as an FK
    // violation rather than as a visibility assertion.
    await testPool.query(`INSERT INTO orgs(id,name) VALUES ('o2','Other')`);
    const u2 = await authService.createUser({ orgId: 'o2', username: 'b', password: 'pw12345' });
    await testPool.query(
      `INSERT INTO provider_keys(id,org_id,provider,api_key_encrypted,created_by) VALUES ('pk2-o2','o2','deepseek','y',$1)`,
      [u2.id],
    );
    await testPool.query(
      `INSERT INTO model_catalog(id,org_id,provider_key_id,provider,model,display_name)
       VALUES ('mc:o2:y','o2','pk2-o2','deepseek','y','Y')`);
    await testPool.query(
      `INSERT INTO token_usage(org_id,user_id,model_id,provider,token_in,token_out,total_tokens,result_code,quota_window_date,ts)
       VALUES ('o2',$1,'mc:o2:y','deepseek',1,1,2,200,'2026-03-01','2026-03-02T10:00:00Z')`,
      [u2.id],
    );
    const r = await queryModels({ orgId: 'o1', from: FROM, to: TO, page: 1, pageSize: 50 });
    expect(r.items.map((i) => i.model)).toEqual(['x']);
  });

  test('call_count includes zero-token failure rows and unaccounted stream calls', async () => {
    await seedCatalog('a');
    await usage('anthropic', 'a', 0);
    await usage('anthropic', 'a', 0, { missing: true });
    const r = await queryModels({ orgId: 'o1', from: FROM, to: TO, page: 1, pageSize: 50 });
    expect(r.items[0].call_count).toBe(2);
    expect(r.unaccounted_calls).toBe(1);
  });

  test('paging is stable across calls and ordered by tokens desc', async () => {
    for (const m of ['a','b','c','d','e']) await seedCatalog(m);
    for (const [m, tk] of [['a',1],['b',2],['c',3],['d',4],['e',5]] as const) await usage('anthropic', m, tk);
    const p1 = await queryModels({ orgId: 'o1', from: FROM, to: TO, page: 1, pageSize: 2 });
    const p2 = await queryModels({ orgId: 'o1', from: FROM, to: TO, page: 1, pageSize: 2 });
    expect(p1.items.map((i) => i.model)).toEqual(['e','d']);
    expect(p2.items.map((i) => i.model)).toEqual(['e','d']);
    expect(p1.total).toBe(5);
  });

  // I-1: `total` and `unaccounted_calls` must hold even when the page slice
  // is empty, not collapse to 0. `COUNT(*) OVER ()` only ran on the
  // post-LIMIT rows; the rebuilt SQL computes both via scalar subqueries
  // against `joined` / `usage_agg`, so the page slice is irrelevant.
  test('total stays correct even when page is past the end', async () => {
    for (const m of ['a','b','c']) {
      await seedCatalog(m);
      await usage('anthropic', m, 10);
    }
    const p1 = await queryModels({ orgId: 'o1', from: FROM, to: TO, page: 1, pageSize: 2 });
    const p99 = await queryModels({ orgId: 'o1', from: FROM, to: TO, page: 99, pageSize: 2 });
    expect(p1.items).toHaveLength(2);
    expect(p1.total).toBe(3);
    expect(p99.items).toEqual([]);
    expect(p99.total).toBe(3); // collapsed to 0 before the fix
  });

  test('unaccounted_calls is identical across pages', async () => {
    await seedCatalog('a');
    await usage('anthropic', 'a', 0, { missing: true });
    await usage('anthropic', 'a', 0, { missing: true });
    const p1 = await queryModels({ orgId: 'o1', from: FROM, to: TO, page: 1, pageSize: 1 });
    const p9 = await queryModels({ orgId: 'o1', from: FROM, to: TO, page: 9, pageSize: 1 });
    expect(p1.items).toHaveLength(1);
    expect(p9.items).toEqual([]);
    expect(p1.unaccounted_calls).toBe(2);
    expect(p9.unaccounted_calls).toBe(2); // collapsed to 0 before the fix
  });

  // I-2: A pair of rows at 2,147,483,647 tokens each sums to 4.3e9, above
  // the int4 ceiling. `SUM(...)::int` raises `integer out of range` and
  // 500s the route; `SUM(...)::bigint` survives, and `Number()` in JS is
  // exact up to 2^53. Run the same shape the reviewer reproduced.
  test('large token sums (above int4 ceiling) do not error', async () => {
    await seedCatalog('opus');
    // Each row's total_tokens = 2,000,000,000 (still inside int4). SUM
    // = 4,000,000,000 — well over 2,147,483,647. Pin both the literal
    // value AND the `ts` so the row lands inside the [from, to) window
    // (the column defaults to `now()`, which would silently fall outside
    // a frozen test range and yield an empty result).
    await testPool.query(
      `INSERT INTO token_usage(org_id,user_id,model_id,provider,token_in,token_out,total_tokens,result_code,quota_window_date,ts)
       VALUES ('o1',$1,'mc:opus','anthropic',1,1,2000000000,200,'2026-03-01','2026-03-02T10:00:00Z'),
              ('o1',$1,'mc:opus','anthropic',1,1,2000000000,200,'2026-03-01','2026-03-02T10:00:00Z')`,
      [userId],
    );
    const r = await queryModels({ orgId: 'o1', from: FROM, to: TO, page: 1, pageSize: 50 });
    expect(r.items).toHaveLength(1);
    expect(r.items[0].total_tokens).toBe(4_000_000_000);
  });

  // Minor 1 (M1 discriminator): the previous "ordering" test gave
  // 22/22 even after removing the `provider ASC` tiebreaker — the
  // runtime order in pglite happens to align with alphabetical provider
  // for that data shape, so the assertion did not actually need the
  // tiebreaker to pass. Inspect the SQL text instead: the contract is
  // "ORDER BY ends with provider ASC", and any future draft that drops
  // that tiebreaker fails this test directly. Verified by deleting
  // `, provider ASC` from `src/analytics/usage.ts`: this test turns red.
  //
  // The clause is bounded by `${paging}`, not by a literal `LIMIT`: since
  // Task 9 the statement is one template parameterised by its window, so
  // the CSV export's SQL is this text with the window dropped. Anchoring on
  // `${paging}` keeps the guard reading the ORDER BY of that shared template
  // — which is exactly the clause both paths execute.
  test('ORDER BY ends with provider ASC as a final tiebreaker', async () => {
    const fs = await import('node:fs');
    const { fileURLToPath } = await import('node:url');
    const usagePath = fileURLToPath(new URL('../../src/analytics/usage.ts', import.meta.url));
    const src = fs.readFileSync(usagePath, 'utf8');
    // Anchor on the models template so this cannot pass on the users clause,
    // whose last key is user_id.
    const block = src.slice(src.indexOf('function modelsQuery'), src.indexOf('const AGGREGATES_QUERY'));
    const orderBy = block.match(/ORDER BY\s+([\s\S]+?)\s+\$\{paging\}/i);
    expect(orderBy).not.toBeNull();
    // Take the last non-comment, non-blank line of the ORDER BY clause.
    // Comments (`-- ...`), blank lines, and full-line noise are filtered
    // out so a comment that mentions "provider ASC" cannot satisfy the
    // test without a real sort key. We avoid splitting by comma because
    // `COALESCE(a, b)` would otherwise be cut in two.
    const lines = orderBy![1]
      .split('\n')
      .map((l) => l.replace(/--.*$/, '').trim())
      .filter(Boolean);
    const lastKey = lines[lines.length - 1];
    // The last sort key must reference the `provider` column (i.e. one
    // of catalog_provider/usage_provider/COALESCE catalog_provider,
    // usage_provider) and end with ASC. Two checks together rule out
    // both "no provider reference" and "provider reference but DESC".
    expect(lastKey).toMatch(/provider/i);
    expect(lastKey).toMatch(/ASC$/i);
  });

  // Cross-provider tie: even with the SQL-text guard above, keep one
  // runtime assertion that catches a SQL rewrite that REORDERS the
  // tiebreaker within the clause rather than dropping it. Two rows at
  // the same tokens, same model, different providers; assert the cross-
  // provider ordering is anthropic before deepseek regardless of the
  // rest of the sort keys. This one happens to also pass on pglite
  // without the tiebreaker — its purpose is the SQL text guard, not
  // this — but it's a separate failure shape (silent reordering) so
  // it's worth keeping.
  test('runtime: cross-provider equal-token ties come out in alphabetical provider order', async () => {
    await testPool.query(
      `INSERT INTO provider_keys(id,org_id,provider,api_key_encrypted,created_by)
       VALUES ('pk-deepseek','o1','deepseek','z',$1)`,
      [userId],
    );
    await testPool.query(
      `INSERT INTO model_catalog(id,org_id,provider_key_id,provider,model,display_name) VALUES
        ('mc-anthropic-opus','o1','pk1','anthropic','opus','Claude Opus'),
        ('mc-deepseek-opus','o1','pk-deepseek','deepseek','opus','Deepseek Opus')`);
    await testPool.query(
      `INSERT INTO token_usage(org_id,user_id,model_id,provider,token_in,token_out,total_tokens,result_code,quota_window_date,ts)
       VALUES ('o1',$1,'mc-anthropic-opus','anthropic',1,1,100,200,'2026-03-01','2026-03-02T10:00:00Z'),
              ('o1',$1,'mc-deepseek-opus','deepseek', 1,1,100,200,'2026-03-01','2026-03-02T10:00:00Z')`,
      [userId],
    );
    const r = await queryModels({ orgId: 'o1', from: FROM, to: TO, page: 1, pageSize: 50 });
    const opus = r.items.filter((i) => i.model === 'opus');
    expect(opus.map((o) => o.provider)).toEqual(['anthropic', 'deepseek']);
  });

  // M4 discriminator: pg delivers `bigint` as a string, pglite delivers it
  // as a JS number. Asserting `typeof === 'number'` against real query
  // output is therefore not a guard — deleting every Number() in
  // `src/analytics/usage.ts` leaves the suite green. Stub `pool.query`
  // to mimic the production wire shape (strings for bigint) and assert
  // the mapper coerces. Verified by deleting the `Number(...)` calls
  // from the mapper rows in `src/analytics/usage.ts`: this test turns
  // red — every `expect(typeof ...).toBe('number')` fails because the
  // mapper now returns the pg-driver string verbatim.
  test('aggregate columns are coerced from string to number (pg-driver shape)', async () => {
    const { pool: prodPool } = await import('../../src/db/pool');
    // Return the page query first, then the aggregates query. Both in
    // pg-driver wire shape: numbers as strings.
    const spy = vi.spyOn(prodPool, 'query');
    spy.mockImplementationOnce(async () => ({
      rows: [{
        provider: 'anthropic',
        model: 'opus',
        display_name: 'Claude Opus',
        total_tokens: '200',       // pg-driver shape: string
        call_count: '1',           // string
      }],
      rowCount: 1,
    }));
    spy.mockImplementationOnce(async () => ({
      rows: [{
        grand_total: '3',          // string
        missing_total: '2',        // string
      }],
      rowCount: 1,
    }));

    const r = await queryModels({ orgId: 'o1', from: FROM, to: TO, page: 1, pageSize: 50 });
    // Every quantitative field is a JS number on the way out.
    expect(typeof r.items[0].total_tokens).toBe('number');
    expect(typeof r.items[0].call_count).toBe('number');
    expect(typeof r.total).toBe('number');
    expect(typeof r.unaccounted_calls).toBe('number');
    // And the values match what the stub returned (parses successfully).
    expect(r.items[0].total_tokens).toBe(200);
    expect(r.items[0].call_count).toBe(1);
    expect(r.total).toBe(3);
    expect(r.unaccounted_calls).toBe(2);

    spy.mockRestore();
  });

  // HTTP-level companion: the route's response body must also carry
  // numbers, since pg would otherwise deliver a JSON body full of
  // stringly-typed numerics.
  test('the JSON envelope from the route carries numbers (not strings)', async () => {
    const app = new Hono();
    const { adminUsageRoutes } = await import('../../src/routes/admin/usage');
    app.route('/', adminUsageRoutes);

    const { pool: prodPool } = await import('../../src/db/pool');
    const spy = vi.spyOn(prodPool, 'query');
    spy.mockImplementation(async () => ({
      rows: [{
        provider: 'anthropic',
        model: 'opus',
        display_name: 'Claude Opus',
        total_tokens: '200',
        call_count: '1',
      }],
      rowCount: 1,
    }));

    const token = await signToken({ sub: 'u1', orgId: 'o1', roles: ['super_admin'] });
    const res = await app.request('/admin/usage/models?range=7d', {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      total: unknown;
      unaccounted_calls: unknown;
      items: { total_tokens: unknown; call_count: unknown }[];
    };
    expect(typeof body.total).toBe('number');
    expect(typeof body.unaccounted_calls).toBe('number');
    for (const row of body.items) {
      expect(typeof row.total_tokens).toBe('number');
      expect(typeof row.call_count).toBe('number');
    }
    spy.mockRestore();
  });
});

describe('GET /admin/usage/models', () => {
  beforeEach(async () => {
    await resetSchema(); await runMigrations();
    await testPool.query(`INSERT INTO orgs(id,name) VALUES ('o1','T')`);
    const u = await authService.createUser({ orgId: 'o1', username: 'a', password: 'pw12345' });
    await testPool.query(`UPDATE users SET extra_roles='["super_admin"]' WHERE id=$1`, [u.id]);
  });

  test('requires usage:view and returns the documented envelope', async () => {
    const app = new Hono();
    const { adminUsageRoutes } = await import('../../src/routes/admin/usage');
    app.route('/', adminUsageRoutes);
    const token = await signToken({ sub: 'u1', orgId: 'o1', roles: ['super_admin'] });
    const res = await app.request('/admin/usage/models?range=7d', { headers: { authorization: `Bearer ${token}` } });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ timezone: expect.any(String) });
    expect(body).toHaveProperty('unaccounted_calls');
    expect(body).toHaveProperty('total');
  });

  test('?model=<provider>/<model> narrows the envelope to that row', async () => {
    const app = new Hono();
    const { adminUsageRoutes } = await import('../../src/routes/admin/usage');
    app.route('/', adminUsageRoutes);
    await testPool.query(
      `INSERT INTO provider_keys(id,org_id,provider,api_key_encrypted) VALUES ('pk1','o1','anthropic','x')`
    );
    await seedCatalog('alpha');
    await seedCatalog('beta', { modelId: 'mc:beta' });
    const u = await authService.createUser({ orgId: 'o1', username: 'z', password: 'pw12345' });
    userId = u.id;
    await usage('anthropic', 'alpha', 10);
    await usage('anthropic', 'beta', 20);
    const token = await signToken({ sub: 'u1', orgId: 'o1', roles: ['super_admin'] });
    const res = await app.request('/admin/usage/models?range=7d&model=anthropic/beta', {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as ModelsBody;
    expect(body.items).toHaveLength(1);
    expect(body.items[0].model).toBe('beta');
    expect(body.total).toBe(1);
  });

  test('a model id containing slashes survives (split on the FIRST slash)', async () => {
    const app = new Hono();
    const { adminUsageRoutes } = await import('../../src/routes/admin/usage');
    app.route('/', adminUsageRoutes);
    await testPool.query(
      `INSERT INTO provider_keys(id,org_id,provider,api_key_encrypted) VALUES ('pk1','o1','vllm','x')`
    );
    await seedCatalog('org/repo/model', { providerKeyId: 'pk1', provider: 'vllm' });
    const u = await authService.createUser({ orgId: 'o1', username: 'z', password: 'pw12345' });
    userId = u.id;
    await usage('vllm', 'org/repo/model', 10);
    const token = await signToken({ sub: 'u1', orgId: 'o1', roles: ['super_admin'] });
    const res = await app.request('/admin/usage/models?range=7d&model=vllm/org/repo/model', {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as ModelsBody;
    expect(body.items).toHaveLength(1);
    expect(body.items[0].model).toBe('org/repo/model');
  });

  test.each([['nope'], ['/leading'], ['trailing/']])(
    'a malformed ?model=%s is a 400, not a silent full listing',
    async (value) => {
      const app = new Hono();
      const { adminUsageRoutes } = await import('../../src/routes/admin/usage');
      app.route('/', adminUsageRoutes);
      const token = await signToken({ sub: 'u1', orgId: 'o1', roles: ['super_admin'] });
      const res = await app.request(
        `/admin/usage/models?range=7d&model=${encodeURIComponent(value)}`,
        { headers: { authorization: `Bearer ${token}` } }
      );
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: 'invalid_model' });
    }
  );

  test('an unauthenticated caller gets 401', async () => {
    const app = new Hono();
    const { adminUsageRoutes } = await import('../../src/routes/admin/usage');
    app.route('/', adminUsageRoutes);
    expect((await app.request('/admin/usage/models?range=7d')).status).toBe(401);
  });

  // Minor 3: super_admin short-circuits on claims.roles.includes(...)
  // before the roleResolver even runs, so a token whose only role is
  // super_admin does not exercise the live permission lookup. The brief
  // asked for `UPDATE users SET roles=...`, which targets a column that
  // does not exist (the field is `extra_roles`). Cover the reachable
  // path the brief was pointing at: a non-super_admin role that DOES
  // carry usage:view — auditor after migration 052 — reaches 200.
  test('a non-super_admin role with usage:view can reach the endpoint', async () => {
    const app = new Hono();
    const { adminUsageRoutes } = await import('../../src/routes/admin/usage');
    app.route('/', adminUsageRoutes);
    const token = await signToken({ sub: 'u1', orgId: 'o1', roles: ['auditor'] });
    const res = await app.request('/admin/usage/models?range=7d', {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(200);
  });

  test('a role without usage:view gets 403', async () => {
    const app = new Hono();
    const { adminUsageRoutes } = await import('../../src/routes/admin/usage');
    app.route('/', adminUsageRoutes);
    // 'dev' has no usage:view in BUILTIN_ROLE_POINTS, so this is a real
    // 403 rather than a super_admin bypass.
    const token = await signToken({ sub: 'u1', orgId: 'o1', roles: ['dev'] });
    const res = await app.request('/admin/usage/models?range=7d', {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(403);
  });

  test('the JSON envelope carries numbers (not strings) over the wire', async () => {
    // Round-trip the response shape through JSON.parse to catch any
    // accidental String() coercion that the unit-level test could miss
    // (where pglite may already be numeric). The production pg driver
    // hands bigint as a string; the shape must survive that on either
    // backend.
    const app = new Hono();
    const { adminUsageRoutes } = await import('../../src/routes/admin/usage');
    app.route('/', adminUsageRoutes);
    // Seed a row to populate the fields, then exercise the endpoint
    // with a fresh DB.
    await testPool.query(
      `INSERT INTO provider_keys(id,org_id,provider,api_key_encrypted,created_by) VALUES ('pk1','o1','anthropic','x',(SELECT id FROM users WHERE org_id='o1' LIMIT 1)) ON CONFLICT DO NOTHING`);
    await testPool.query(
      `INSERT INTO model_catalog(id,org_id,provider_key_id,provider,model,display_name) VALUES ('mc:opus','o1','pk1','anthropic','opus','Claude Opus') ON CONFLICT DO NOTHING`);
    await testPool.query(
      `INSERT INTO token_usage(org_id,user_id,model_id,provider,token_in,token_out,total_tokens,result_code,quota_window_date,usage_missing)
       VALUES ('o1',(SELECT id FROM users WHERE org_id='o1' LIMIT 1),'mc:opus','anthropic',1,1,2,200,'2026-03-01',true)`);

    const token = await signToken({ sub: 'u1', orgId: 'o1', roles: ['super_admin'] });
    const res = await app.request('/admin/usage/models?range=7d', {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      total: unknown;
      unaccounted_calls: unknown;
      items: { total_tokens: unknown; call_count: unknown }[];
    };
    expect(typeof body.total).toBe('number');
    expect(typeof body.unaccounted_calls).toBe('number');
    for (const row of body.items) {
      expect(typeof row.total_tokens).toBe('number');
      expect(typeof row.call_count).toBe('number');
    }
  });

  test('an unrecognized range returns 400 (does not 500)', async () => {
    const app = new Hono();
    const { adminUsageRoutes } = await import('../../src/routes/admin/usage');
    app.route('/', adminUsageRoutes);
    const token = await signToken({ sub: 'u1', orgId: 'o1', roles: ['super_admin'] });
    const res = await app.request('/admin/usage/models?range=garbage', {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(400);
  });

  test('a hugely oversized page value is clamped, not crashed', async () => {
    // Minor 2: the route caps page to 1,000,000 instead of letting an
    // OFFSET past bigint's safe range reach Postgres. A 20-digit
    // `page` value should be silently clamped and the route should
    // still 200.
    const app = new Hono();
    const { adminUsageRoutes } = await import('../../src/routes/admin/usage');
    app.route('/', adminUsageRoutes);
    const token = await signToken({ sub: 'u1', orgId: 'o1', roles: ['super_admin'] });
    const res = await app.request('/admin/usage/models?range=7d&page=99999999999999999999', {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(200);
  });
});

// --- Deep-link filter (dashboard → 模型用量 TOP5 row → this table) ---
describe('queryModels — model 过滤', () => {
  beforeEach(async () => {
    await resetSchema(); await runMigrations();
    await testPool.query(`INSERT INTO orgs(id,name) VALUES ('o1','T')`);
    const u = await authService.createUser({ orgId: 'o1', username: 'a', password: 'pw12345' });
    userId = u.id;
    // `seedCatalog` defaults to provider_key_id 'pk1' and `usage()` writes
    // through the module-level `userId`, so both have to exist here.
    for (const pk of ['pk1', 'pk2', 'pk3']) {
      await testPool.query(
        `INSERT INTO provider_keys(id,org_id,provider,api_key_encrypted,created_by) VALUES ($1,'o1','anthropic','x',$2)`,
        [pk, userId]
      );
    }
  });

  test('model 过滤只返回该 (provider, model) 行', async () => {
    await seedCatalog('alpha');
    await seedCatalog('beta', { modelId: 'mc:beta', providerKeyId: 'pk2' });
    await usage('anthropic', 'alpha', 100);
    await usage('anthropic', 'beta', 900);
    const r = await queryModels({
      orgId: 'o1', from: FROM, to: TO, page: 1, pageSize: 50,
      model: { provider: 'anthropic', model: 'beta' },
    });
    expect(r.items).toHaveLength(1);
    expect(r.items[0].model).toBe('beta');
    // `usage()` seeds total_tokens as `tokens * 2`.
    expect(r.items[0].total_tokens).toBe(1800);
  });

  test('model 过滤下 total 也只计该行，分页脚注才不会与高亮行打架', async () => {
    await seedCatalog('alpha');
    await seedCatalog('beta', { modelId: 'mc:beta', providerKeyId: 'pk2' });
    await seedCatalog('gamma', { modelId: 'mc:gamma', providerKeyId: 'pk3' });
    await usage('anthropic', 'alpha', 100);
    await usage('anthropic', 'beta', 900);
    await usage('anthropic', 'gamma', 300);
    const all = await queryModels({ orgId: 'o1', from: FROM, to: TO, page: 1, pageSize: 50 });
    expect(all.total).toBe(3);
    const filtered = await queryModels({
      orgId: 'o1', from: FROM, to: TO, page: 1, pageSize: 50,
      model: { provider: 'anthropic', model: 'beta' },
    });
    expect(filtered.total).toBe(1);
  });

  test('不传 model 时结果与既有行为一致', async () => {
    await seedCatalog('alpha');
    await seedCatalog('beta', { modelId: 'mc:beta', providerKeyId: 'pk2' });
    await usage('anthropic', 'alpha', 100);
    await usage('anthropic', 'beta', 900);
    const r = await queryModels({ orgId: 'o1', from: FROM, to: TO, page: 1, pageSize: 50 });
    expect(r.total).toBe(2);
    expect(r.items.map((m) => m.model).sort()).toEqual(['alpha', 'beta']);
  });

  test('过滤无命中时返回空 items 而不是全量', async () => {
    await seedCatalog('alpha');
    await usage('anthropic', 'alpha', 100);
    const r = await queryModels({
      orgId: 'o1', from: FROM, to: TO, page: 1, pageSize: 50,
      model: { provider: 'anthropic', model: 'nope' },
    });
    expect(r.items).toEqual([]);
    expect(r.total).toBe(0);
  });
});
