import '../helpers/setupEnv';

import { beforeEach, describe, expect, test, vi } from 'vitest';
vi.mock('../../src/db/pool', async () => {
  const td = await import('../../src/db/testDb');
  return { pool: td.testPool };
});
import { Hono } from 'hono';

import { queryUserDetail, queryUsers, type UsageUsersQuery, type UserDetailQuery } from '../../src/analytics/usage';
import { authService } from '../../src/auth/authService';
import { signToken } from '../../src/auth/jwt';
import { resetSchema, runMigrations, testPool } from '../../src/db/testDb';

const FROM = new Date('2026-03-01T00:00:00Z');
const TO = new Date('2026-03-08T00:00:00Z');

// `provider_keys.created_by` is NOT NULL REFERENCES users(id), so the roster is
// built with the UUID authService returns rather than the literal 'u1' the
// brief proposed. u3 deliberately has a NULL display_name so the
// COALESCE(display_name, username) tiebreaker is exercised for real.
const users: { u1: string; u2: string; u3: string } = { u1: '', u2: '', u3: '' };

beforeEach(async () => {
  await resetSchema();
  await runMigrations();
  await testPool.query(`INSERT INTO orgs(id,name) VALUES ('o1','T')`);

  users.u1 = (await authService.createUser({ orgId: 'o1', username: 'zhangwei', password: 'pw12345', displayName: '张伟' })).id;
  users.u2 = (await authService.createUser({ orgId: 'o1', username: 'lina', password: 'pw12345', displayName: '李娜' })).id;
  users.u3 = (await authService.createUser({ orgId: 'o1', username: 'wangwu', password: 'pw12345' })).id;

  await testPool.query(
    `INSERT INTO provider_keys(id,org_id,provider,api_key_encrypted,created_by)
     VALUES ('pk-anthropic','o1','anthropic','x',$1), ('pk-deepseek','o1','deepseek','y',$1)`,
    [users.u1],
  );
});

/** Seed one model_catalog row. Callers must do this before `usage()` — the FK
 * on token_usage.model_id is NOT NULL REFERENCES model_catalog(id) with no
 * ON DELETE, and this suite never drops it. */
async function catalog(
  provider: string,
  model: string,
  opts?: { id?: string; providerKeyId?: string; displayName?: string },
): Promise<string> {
  const id = opts?.id ?? `mc:${provider}:${model}`;
  await testPool.query(
    `INSERT INTO model_catalog(id, org_id, provider_key_id, provider, model, display_name)
     VALUES ($1, 'o1', $2, $3, $4, $5) ON CONFLICT (org_id, provider_key_id, model) DO NOTHING`,
    [id, opts?.providerKeyId ?? `pk-${provider}`, provider, model, opts?.displayName ?? model],
  );
  return id;
}

/** One token_usage row at `<day>T10:00:00Z`. `total_tokens` is the token
 * argument verbatim (NOT doubled) so the brief's numeric assertions read as
 * written; token_in mirrors it and token_out is zero. */
async function usage(
  userId: string,
  provider: string,
  model: string,
  tokens: number,
  day: string,
  opts?: { modelId?: string; missing?: boolean },
): Promise<void> {
  const modelId = opts?.modelId ?? `mc:${provider}:${model}`;
  await testPool.query(
    `INSERT INTO token_usage(org_id,user_id,model_id,provider,token_in,token_out,total_tokens,result_code,quota_window_date,usage_missing,ts)
     VALUES ('o1',$1,$2,$3,$4,0,$4,200,'2026-03-01',$5,$6)`,
    [userId, modelId, provider, tokens, opts?.missing ?? false, `${day}T10:00:00Z`],
  );
}

/** Today's day in UTC — the org zone is UTC in these tests, and
 * `range=7d` resolves against the real clock, so usage seeded for a route test
 * has to land inside that window rather than in a frozen range. */
function today(): string {
  return new Date().toISOString().slice(0, 10);
}

function page(over: Partial<UsageUsersQuery> = {}) {
  return queryUsers({ orgId: 'o1', from: FROM, to: TO, sort: 'desc', page: 1, pageSize: 8, ...over });
}

describe('queryUsers — the list is a full roster (D6)', () => {
  test('every member appears, including zero-usage and disabled ones', async () => {
    await testPool.query(`UPDATE users SET status='disabled' WHERE id=$1`, [users.u3]);
    await catalog('anthropic', 'opus');
    await usage(users.u1, 'anthropic', 'opus', 500, '2026-03-01');

    const r = await page();
    expect(r.items.map((i) => i.user_id).sort()).toEqual([users.u1, users.u2, users.u3].sort());
    const u3 = r.items.find((i) => i.user_id === users.u3)!;
    expect(u3.total_tokens).toBe(0);
    expect(u3.last_used_at).toBeNull();
    // A disabled member with usage is listed too — the absence of a status
    // predicate is what makes this true.
    await testPool.query(`UPDATE users SET status='disabled' WHERE id=$1`, [users.u1]);
    expect((await page()).items.map((i) => i.user_id)).toContain(users.u1);
  });

  test('total is the whole roster, not the page slice', async () => {
    await catalog('anthropic', 'opus');
    await usage(users.u1, 'anthropic', 'opus', 10, '2026-03-01');
    const all = await page({ pageSize: 8 });
    expect(all.total).toBe(3);
    expect(all.items).toHaveLength(3);
  });

  test('a user_archives row does NOT remove the member from the roster', async () => {
    // `user_archives` stores workspace snapshots; it says nothing about whether
    // the users row exists. Filtering on it would silently drop live members
    // whose workspace happened to be archived.
    await testPool.query(
      `INSERT INTO user_archives(id,org_id,user_id,archive_blob,size_bytes)
       VALUES ('ar1','o1',$1,'\\x00',1)`,
      [users.u3],
    );
    const r = await page();
    expect(r.items.map((i) => i.user_id)).toContain(users.u3);
    expect(r.total).toBe(3);
  });

  test('another org is never visible', async () => {
    await testPool.query(`INSERT INTO orgs(id,name) VALUES ('o2','Other')`);
    const outsider = await authService.createUser({ orgId: 'o2', username: 'outsider', password: 'pw12345', displayName: '外人' });
    const r = await page();
    expect(r.items.map((i) => i.user_id)).not.toContain(outsider.id);
    expect(r.total).toBe(3);
  });

  test('department name is joined through, null when unset', async () => {
    // `departments.path` is NOT NULL with no default, so the brief's
    // three-column INSERT cannot run — path must be supplied.
    await testPool.query(
      `INSERT INTO departments(id,org_id,name,path) VALUES ('d1','o1','研发中心','/研发中心')`,
    );
    await testPool.query(`UPDATE users SET department_id='d1' WHERE id=$1`, [users.u1]);

    const r = await page();
    expect(r.items.find((i) => i.user_id === users.u1)!.department_name).toBe('研发中心');
    expect(r.items.find((i) => i.user_id === users.u2)!.department_name).toBeNull();
    expect(r.items.find((i) => i.user_id === users.u3)!.department_name).toBeNull();
  });

  test("a department pointing at another org renders null rather than leaking its name", async () => {
    // departments.id is a global PK and users.department_id carries no org
    // constraint, so a mis-pointed row is representable. The LEFT JOIN's ON
    // clause re-checks org_id so the foreign name cannot reach the response.
    await testPool.query(`INSERT INTO orgs(id,name) VALUES ('o2','Other')`);
    await testPool.query(`INSERT INTO departments(id,org_id,name,path) VALUES ('d2','o2','外部门','/外部门')`);
    await testPool.query(`UPDATE users SET department_id='d2' WHERE id=$1`, [users.u1]);
    const r = await page();
    expect(r.items.find((i) => i.user_id === users.u1)!.department_name).toBeNull();
  });

  test('last_used_at is the most recent call in range, not outside it', async () => {
    await catalog('anthropic', 'opus');
    await usage(users.u1, 'anthropic', 'opus', 10, '2026-03-05');
    await usage(users.u1, 'anthropic', 'opus', 10, '2026-04-09');
    const r = await page();
    expect(r.items[0].user_id).toBe(users.u1);
    expect(r.items[0].last_used_at).toBe('2026-03-05T10:00:00.000Z');
  });

  test('rows at the exclusive TO bound are excluded from the total too', async () => {
    await catalog('anthropic', 'opus');
    await usage(users.u1, 'anthropic', 'opus', 10, '2026-03-07');
    await usage(users.u1, 'anthropic', 'opus', 10, '2026-03-08');
    const r = await page();
    expect(r.items[0].total_tokens).toBe(10);
    expect(r.items[0].last_used_at).toBe('2026-03-07T10:00:00.000Z');
  });
});

describe('queryUsers — paging is deterministic', () => {
  test('paging does not shift between identical calls when several members tie at zero', async () => {
    await catalog('anthropic', 'opus');
    await usage(users.u2, 'anthropic', 'opus', 0, '2026-03-01');
    await usage(users.u3, 'anthropic', 'opus', 0, '2026-03-01');
    const a = await page({ page: 2, pageSize: 1 });
    const b = await page({ page: 2, pageSize: 1 });
    expect(a.items[0].user_id).toBe(b.items[0].user_id);
  });

  // The brief's own two-call comparison passes even with no tiebreaker at all:
  // an identical query returns an identical order, so it cannot discriminate.
  // Walking every page and asserting the union is the roster with no duplicate
  // and no gap is the property the product actually needs, and it fails when
  // rows tie and the boundary moves.
  test('a full page-by-page sweep yields every member exactly once, repeatably', async () => {
    // Same tokens AND the same display_name for u2/u3, so the only remaining
    // sort key is user_id — exactly the case the tiebreaker exists for.
    await testPool.query(`UPDATE users SET display_name='同名' WHERE id=$1`, [users.u2]);
    await testPool.query(`UPDATE users SET display_name='同名' WHERE id=$1`, [users.u3]);
    await catalog('anthropic', 'opus');
    await usage(users.u1, 'anthropic', 'opus', 0, '2026-03-01');

    async function sweep(): Promise<string[]> {
      const seen: string[] = [];
      for (let p = 1; p <= 5; p++) {
        const r = await page({ page: p, pageSize: 1 });
        seen.push(...r.items.map((i) => i.user_id));
      }
      return seen;
    }
    const first = await sweep();
    const second = await sweep();
    expect(first).toHaveLength(3);
    expect(new Set(first).size).toBe(3);
    expect([...first].sort()).toEqual([users.u1, users.u2, users.u3].sort());
    expect(second).toEqual(first);
    // Past the end the roster still reports its true total.
    expect((await page({ page: 99, pageSize: 1 })).total).toBe(3);
  });

  // Runtime discriminator for the SQL-text guard below: equal tokens and equal
  // display names, so only `user_id ASC` can decide the order.
  test('runtime: members tied on tokens and display_name come out in user_id order', async () => {
    await testPool.query(`UPDATE users SET display_name='同名' WHERE id=$1`, [users.u2]);
    await testPool.query(`UPDATE users SET display_name='同名' WHERE id=$1`, [users.u3]);
    await catalog('anthropic', 'opus');
    await usage(users.u1, 'anthropic', 'opus', 500, '2026-03-01');
    const r = await page();
    const tied = r.items.filter((i) => i.total_tokens === 0).map((i) => i.user_id);
    expect(tied).toHaveLength(2);
    expect([...tied].sort()).toEqual([users.u2, users.u3].sort());
  });

  // Source-text guard: the ORDER BY must END with a unique key. Two identical
  // requests always agree on pglite, so no runtime assertion here can prove the
  // tiebreaker exists — deleting the last key from the SQL does not change any
  // observed order. Inspecting the clause is the only discriminating check.
  //
  // The clause is bounded by `${paging}`, not a literal `LIMIT`: since Task 9
  // this statement is one template parameterised by its paging window (the CSV
  // export is the same SQL with the window dropped), so anchoring on LIMIT would
  // have found nothing. usageExport.test.ts separately proves the export's
  // executed SQL really does carry this ORDER BY.
  test('ORDER BY ends with user_id ASC as a final tiebreaker', async () => {
    const fs = await import('node:fs');
    const { fileURLToPath } = await import('node:url');
    const usagePath = fileURLToPath(new URL('../../src/analytics/usage.ts', import.meta.url));
    const src = fs.readFileSync(usagePath, 'utf8');
    // The users ORDER BY is the one whose last key is user_id; the models one
    // ends with provider. Anchor on the queryUsers block so this cannot pass on
    // the models clause.
    const block = src.slice(src.indexOf('function usersPageQuery'));
    const orderBy = block.match(/ORDER BY\s+([\s\S]+?)\s+\$\{paging\}/i);
    expect(orderBy).not.toBeNull();
    const lines = orderBy![1]
      .split('\n')
      .map((l) => l.replace(/--.*$/, '').trim())
      .filter(Boolean);
    const lastKey = lines[lines.length - 1];
    expect(lastKey).toMatch(/user_id/i);
    expect(lastKey).toMatch(/ASC$/i);
  });

  test('sort ascending puts the heaviest consumer last, tiebreaker unchanged', async () => {
    // u2 and u3 tie on BOTH tokens and display_name, so only the tiebreaker
    // orders them — in the same order whichever way `sort` points.
    await testPool.query(`UPDATE users SET display_name='同名' WHERE id=$1`, [users.u2]);
    await testPool.query(`UPDATE users SET display_name='同名' WHERE id=$1`, [users.u3]);
    await catalog('anthropic', 'opus');
    await usage(users.u1, 'anthropic', 'opus', 900, '2026-03-01');
    await usage(users.u2, 'anthropic', 'opus', 100, '2026-03-01');
    await usage(users.u3, 'anthropic', 'opus', 100, '2026-03-01');

    const asc = await page({ sort: 'asc' });
    expect(asc.items[asc.items.length - 1].user_id).toBe(users.u1);
    expect(asc.items[0].total_tokens).toBe(100);
    const ascTied = asc.items.filter((i) => i.total_tokens === 100).map((i) => i.user_id);

    // Flipping `sort` moves the token key, not the tiebreaker: the tied pair
    // keeps its relative order at the head of a DESC page and the tail of an
    // ASC one.
    const desc = await page({ sort: 'desc' });
    const descTied = desc.items.filter((i) => i.total_tokens === 100).map((i) => i.user_id);
    expect(ascTied).toHaveLength(2);
    expect(descTied).toEqual(ascTied);
    expect([...ascTied].sort()).toEqual([users.u2, users.u3].sort());
  });
  test('page and pageSize are floored and clamped by the query itself', async () => {
    const r = await page({ page: -3, pageSize: 0 });
    expect(r.page).toBe(1);
    expect(r.pageSize).toBe(1);
    expect(r.total).toBe(3);
  });
});

describe('queryUsers — search', () => {
  test('search matches display name or username, case-insensitively', async () => {
    const zh = await page({ q: '张' });
    expect(zh.items.map((i) => i.user_id)).toEqual([users.u1]);
    const en = await page({ q: 'LI' });
    expect(en.items.map((i) => i.user_id)).toEqual([users.u2]);
    // total tracks the filter, so the pager reflects the search.
    expect(en.total).toBe(1);
    // A member whose display_name is NULL must still be findable by username.
    expect((await page({ q: 'wangwu' })).items.map((i) => i.user_id)).toEqual([users.u3]);
  });

  test('search does not restrict the org-wide unaccounted_calls count', async () => {
    await catalog('anthropic', 'opus');
    await usage(users.u2, 'anthropic', 'opus', 0, '2026-03-01', { missing: true });
    const all = await page();
    const filtered = await page({ q: '张' });
    expect(all.unaccounted_calls).toBe(1);
    expect(filtered.items).toHaveLength(1);
    expect(filtered.unaccounted_calls).toBe(1);
  });

  test('LIKE metacharacters in q are matched literally', async () => {
    // Without escaping, a `%` in the box matches every row and the list
    // silently becomes useless. Same result for every metacharacter-free
    // query, so this only pins the escaping.
    expect((await page({ q: '%' })).items).toEqual([]);
    expect((await page({ q: '_' })).items).toEqual([]);
    expect((await page({ q: 'zhang' })).items.map((i) => i.user_id)).toEqual([users.u1]);
  });
});

describe('queryUsers — numeric shape', () => {
  // SUM over INTEGER raises `integer out of range` past 2,147,483,647 and the
  // route has no boundary that keeps it away, so ::bigint is load-bearing.
  test('large token sums (above the int4 ceiling) do not error', async () => {
    await catalog('anthropic', 'opus');
    await testPool.query(
      `INSERT INTO token_usage(org_id,user_id,model_id,provider,token_in,token_out,total_tokens,result_code,quota_window_date,ts)
       VALUES ('o1',$1,'mc:anthropic:opus','anthropic',2000000000,0,2000000000,200,'2026-03-01','2026-03-02T10:00:00Z'),
              ('o1',$1,'mc:anthropic:opus','anthropic',2000000000,0,2000000000,200,'2026-03-01','2026-03-02T10:00:00Z')`,
      [users.u1],
    );
    const r = await page();
    expect(r.items[0].total_tokens).toBe(4_000_000_000);
  });

  test('total and unaccounted_calls stay correct when page is past the end', async () => {
    await catalog('anthropic', 'opus');
    await usage(users.u1, 'anthropic', 'opus', 0, '2026-03-01', { missing: true });
    await usage(users.u2, 'anthropic', 'opus', 0, '2026-03-01', { missing: true });
    const p1 = await page({ page: 1, pageSize: 1 });
    const p99 = await page({ page: 99, pageSize: 1 });
    expect(p1.items).toHaveLength(1);
    expect(p99.items).toEqual([]);
    expect(p1.total).toBe(3);
    expect(p99.total).toBe(3);
    expect(p1.unaccounted_calls).toBe(2);
    expect(p99.unaccounted_calls).toBe(2);
  });

  // pglite returns int8 as a JS number, so `typeof x === 'number'` against a
  // live query is vacuous: deleting every Number() leaves it green. Stub the
  // pool to return the pg driver's wire shape instead. Queries are told apart
  // by their SQL text rather than call order so the two Promise.all branches
  // cannot swap.
  test('numeric columns are coerced from the pg-driver string shape', async () => {
    const { pool: prodPool } = await import('../../src/db/pool');
    const spy = vi.spyOn(prodPool, 'query');
    spy.mockImplementation(async (sql: string) => {
      if (/ORDER BY/.test(sql)) {
        return {
          rows: [{
            user_id: 'u9',
            username: 'nine',
            display_name: 'Nine',
            department_name: null,
            total_tokens: '4000000000',
            last_used_at: new Date('2026-03-05T10:00:00Z'),
          }],
          rowCount: 1,
        };
      }
      return { rows: [{ roster_total: '137', missing_total: '7' }], rowCount: 1 };
    });
    try {
      const r = await page();
      expect(typeof r.items[0].total_tokens).toBe('number');
      expect(typeof r.total).toBe('number');
      expect(typeof r.unaccounted_calls).toBe('number');
      expect(r.items[0].total_tokens).toBe(4_000_000_000);
      expect(r.total).toBe(137);
      expect(r.unaccounted_calls).toBe(7);
      expect(r.items[0].last_used_at).toBe('2026-03-05T10:00:00.000Z');
    } finally {
      spy.mockRestore();
    }
  });

  test('a null last_used_at and a string last_used_at both map cleanly', async () => {
    const { pool: prodPool } = await import('../../src/db/pool');
    const spy = vi.spyOn(prodPool, 'query');
    spy.mockImplementation(async (sql: string) => {
      if (/ORDER BY/.test(sql)) {
        return {
          rows: [
            { user_id: 'a', username: 'a', display_name: null, department_name: 'D', total_tokens: '0', last_used_at: null },
            { user_id: 'b', username: 'b', display_name: null, department_name: null, total_tokens: '0', last_used_at: '2026-03-05 10:00:00+00' },
          ],
          rowCount: 2,
        };
      }
      return { rows: [{ roster_total: '2', missing_total: '0' }], rowCount: 1 };
    });
    try {
      const r = await page();
      expect(r.items[0].last_used_at).toBeNull();
      expect(r.items[1].last_used_at).toBe('2026-03-05T10:00:00.000Z');
    } finally {
      spy.mockRestore();
    }
  });
});

describe('queryUserDetail', () => {
  function detail(over: Partial<UserDetailQuery> = {}) {
    return queryUserDetail({
      orgId: 'o1',
      userId: users.u1,
      from: FROM,
      to: TO,
      timezone: 'UTC',
      days: ['2026-03-01', '2026-03-02', '2026-03-03'],
      ...over,
    });
  }

  test('daily returns one entry per day of the range, including zero days', async () => {
    await catalog('anthropic', 'opus');
    await usage(users.u1, 'anthropic', 'opus', 700, '2026-03-03');
    const days = ['2026-03-01', '2026-03-02', '2026-03-03', '2026-03-04', '2026-03-05'];
    const r = await detail({ days });
    expect(r.daily).toHaveLength(days.length);
    expect(r.daily[0]).toEqual({ date: '2026-03-01', tokens: 0 });
    expect(r.daily[2]).toEqual({ date: '2026-03-03', tokens: 700 });
    expect(r.daily.map((d) => d.date)).toEqual(days);
  });

  test('a member with no calls yields an all-zero daily series and no model rows', async () => {
    const r = await detail({ userId: users.u3, days: ['2026-03-01', '2026-03-02'] });
    expect(r.daily).toEqual([{ date: '2026-03-01', tokens: 0 }, { date: '2026-03-02', tokens: 0 }]);
    expect(r.by_model).toEqual([]);
    expect(r.unaccounted_calls).toBe(0);
    expect(r.user).toEqual({ user_id: users.u3, display_name: null, department_name: null });
  });

  test('daily covers a 30-day range at full length and stays in the days order', async () => {
    const days = Array.from({ length: 30 }, (_, i) => `2026-03-${String(i + 1).padStart(2, '0')}`);
    const r = await detail({ days });
    expect(r.daily).toHaveLength(30);
    expect(r.daily.map((d) => d.date)).toEqual(days);
  });

  test('daily buckets by the org timezone, not UTC', async () => {
    // 2026-03-01T23:00Z is 2026-03-02 in Asia/Shanghai (UTC+8). With a UTC
    // bucket it lands on the 1st; with the org zone it must land on the 2nd.
    await catalog('anthropic', 'opus');
    await testPool.query(
      `INSERT INTO token_usage(org_id,user_id,model_id,provider,token_in,token_out,total_tokens,result_code,quota_window_date,ts)
       VALUES ('o1',$1,'mc:anthropic:opus','anthropic',99,0,99,200,'2026-03-02','2026-03-01T23:00:00Z')`,
      [users.u1],
    );
    const days = ['2026-03-01', '2026-03-02'];
    expect((await detail({ days })).daily).toEqual([
      { date: '2026-03-01', tokens: 99 },
      { date: '2026-03-02', tokens: 0 },
    ]);
    expect((await detail({ days, timezone: 'Asia/Shanghai' })).daily).toEqual([
      { date: '2026-03-01', tokens: 0 },
      { date: '2026-03-02', tokens: 99 },
    ]);
  });

  test('by_model shares sum to 100 and merge same-named models', async () => {
    await catalog('anthropic', 'opus');
    await catalog('deepseek', 'v4');
    await usage(users.u1, 'anthropic', 'opus', 300, '2026-03-01');
    await usage(users.u1, 'anthropic', 'opus', 100, '2026-03-02');
    await usage(users.u1, 'deepseek', 'v4', 600, '2026-03-01');

    const r = await detail();
    expect(r.by_model.map((m) => m.model)).toEqual(['v4', 'opus']);
    expect(r.by_model[0].pct).toBe(60);
    expect(r.by_model[1]).toMatchObject({ provider: 'anthropic', model: 'opus', tokens: 400, pct: 40 });
    expect(Math.round(r.by_model.reduce((s, m) => s + m.pct, 0))).toBe(100);
    expect(r.daily.reduce((s, d) => s + d.tokens, 0)).toBe(1000);
  });

  test('by_model merges one model across two provider keys (migration 039)', async () => {
    await testPool.query(
      `INSERT INTO provider_keys(id,org_id,provider,api_key_encrypted,created_by) VALUES ('pk-anthropic-2','o1','anthropic','z',$1)`,
      [users.u1],
    );
    await catalog('anthropic', 'opus', { id: 'builtin:opus', providerKeyId: 'pk-anthropic', displayName: 'Claude Opus' });
    await catalog('anthropic', 'opus', { id: 'custom:opus', providerKeyId: 'pk-anthropic-2', displayName: 'Claude Opus' });
    await usage(users.u1, 'anthropic', 'opus', 100, '2026-03-01', { modelId: 'builtin:opus' });
    await usage(users.u1, 'anthropic', 'opus', 250, '2026-03-02', { modelId: 'custom:opus' });

    const r = await detail();
    expect(r.by_model).toHaveLength(1);
    expect(r.by_model[0]).toMatchObject({ provider: 'anthropic', model: 'opus', tokens: 350, pct: 100 });
  });

  test('percentages are zero, not NaN, when the member used nothing', async () => {
    await catalog('anthropic', 'opus');
    await usage(users.u3, 'anthropic', 'opus', 0, '2026-03-01');
    const r = await detail({ userId: users.u3 });
    expect(r.by_model[0]).toMatchObject({ tokens: 0, pct: 0 });
    expect(r.by_model.every((m) => m.pct === 0)).toBe(true);
    expect(Number.isNaN(r.by_model[0].pct)).toBe(false);
  });

  test('pct is rounded to one decimal', async () => {
    await catalog('anthropic', 'opus');
    await catalog('deepseek', 'v4');
    await usage(users.u1, 'anthropic', 'opus', 1, '2026-03-01');
    await usage(users.u1, 'deepseek', 'v4', 2, '2026-03-01');
    const r = await detail();
    expect(r.by_model[0].pct).toBe(66.7);
    expect(r.by_model[1].pct).toBe(33.3);
  });

  test('the drawer shows only that member and only inside the range', async () => {
    await catalog('anthropic', 'opus');
    await usage(users.u1, 'anthropic', 'opus', 100, '2026-03-02');
    await usage(users.u2, 'anthropic', 'opus', 5000, '2026-03-02');
    await usage(users.u1, 'anthropic', 'opus', 7000, '2026-04-01');
    const r = await detail();
    expect(r.daily.reduce((s, d) => s + d.tokens, 0)).toBe(100);
    expect(r.by_model[0].tokens).toBe(100);
  });

  test('unaccounted_calls is scoped to this member', async () => {
    await catalog('anthropic', 'opus');
    await usage(users.u1, 'anthropic', 'opus', 0, '2026-03-01', { missing: true });
    await usage(users.u2, 'anthropic', 'opus', 0, '2026-03-01', { missing: true });
    await usage(users.u2, 'anthropic', 'opus', 0, '2026-03-01', { missing: true });
    expect((await detail()).unaccounted_calls).toBe(1);
    expect((await detail({ userId: users.u2 })).unaccounted_calls).toBe(2);
  });

  test('a user from another org is reported as not found', async () => {
    await testPool.query(`INSERT INTO orgs(id,name) VALUES ('o2','Other')`);
    const outsider = await authService.createUser({ orgId: 'o2', username: 'outsider', password: 'pw12345' });
    const r = await detail({ userId: outsider.id });
    expect(r.user).toBeNull();
    expect(r.daily.every((d) => d.tokens === 0)).toBe(true);
    expect(r.by_model).toEqual([]);
  });

  test('detail numeric columns are coerced from the pg-driver string shape', async () => {
    const { pool: prodPool } = await import('../../src/db/pool');
    const spy = vi.spyOn(prodPool, 'query');
    spy.mockImplementation(async (sql: string) => {
      if (/FROM token_usage[\s\S]*GROUP BY 1/.test(sql) || /date_trunc/.test(sql)) {
        return { rows: [{ day: '2026-03-02', tokens: '4000000000' }], rowCount: 1 };
      }
      if (/GROUP BY[\s\S]*provider/.test(sql)) {
        return { rows: [{ provider: 'anthropic', model: 'opus', display_name: 'Opus', tokens: '4000000000' }], rowCount: 1 };
      }
      if (/usage_missing/.test(sql)) {
        return { rows: [{ missing_total: '3' }], rowCount: 1 };
      }
      return { rows: [{ user_id: 'u1', display_name: 'Nine', department_name: null }], rowCount: 1 };
    });
    try {
      const r = await detail();
      expect(typeof r.daily[0].tokens).toBe('number');
      expect(typeof r.by_model[0].tokens).toBe('number');
      expect(typeof r.by_model[0].pct).toBe('number');
      expect(typeof r.unaccounted_calls).toBe('number');
      expect(r.daily[1].tokens).toBe(4_000_000_000);
      expect(r.by_model[0].pct).toBe(100);
      expect(r.unaccounted_calls).toBe(3);
    } finally {
      spy.mockRestore();
    }
  });
});

describe('GET /admin/usage/users', () => {
  // Returns a request-making thunk so each call site reads `app()(...)` and
  // the dynamic import stays out of the assertions.
  async function app(): Promise<(path: string, init?: RequestInit) => Promise<Response>> {
    const a = new Hono();
    const { adminUsageRoutes } = await import('../../src/routes/admin/usage');
    a.route('/', adminUsageRoutes);
    return async (path, init) => a.request(path, init);
  }

  beforeEach(async () => {
    await testPool.query(
      `UPDATE users SET extra_roles='["super_admin"]' WHERE org_id='o1' AND username='zhangwei'`,
    );
  });

  test('returns the documented envelope with default pageSize 8', async () => {
    await testPool.query(
      `INSERT INTO departments(id,org_id,name,path) VALUES ('d1','o1','研发中心','/研发中心')`,
    );
    await testPool.query(`UPDATE users SET department_id='d1' WHERE id=$1`, [users.u1]);
    const token = await signToken({ sub: users.u1, orgId: 'o1', roles: ['super_admin'] });
    const res = await (await app())('/admin/usage/users?range=7d', {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      range: string;
      pageSize: number;
      total: number;
      unaccounted_calls: number;
      timezone: string;
      items: { user_id: string; username: string; display_name: string | null; department_name: string | null; total_tokens: number; last_used_at: string | null }[];
    };
    expect(body).toMatchObject({
      range: '7d',
      page: 1,
      pageSize: 8,
      timezone: expect.any(String),
      total: 3,
      unaccounted_calls: expect.any(Number),
    });
    expect(body.items).toHaveLength(3);
    expect(body.items.find((i: { user_id: string }) => i.user_id === users.u1)).toMatchObject({
      username: 'zhangwei',
      display_name: '张伟',
      department_name: '研发中心',
      total_tokens: 0,
      last_used_at: null,
    });
  });

  test('forwards q, sort, page and pageSize', async () => {
    await catalog('anthropic', 'opus');
    await usage(users.u1, 'anthropic', 'opus', 900, today());
    await usage(users.u2, 'anthropic', 'opus', 100, today());
    const token = await signToken({ sub: users.u1, orgId: 'o1', roles: ['super_admin'] });
    const res = await (await app())('/admin/usage/users?range=7d&sort=asc&pageSize=1&page=3', {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { page: number; pageSize: number; total: number; items: { user_id: string }[] };
    expect(body).toMatchObject({ page: 3, pageSize: 1, total: 3 });
    expect(body.items[0].user_id).toBe(users.u1);

    const searched = await (await app())('/admin/usage/users?range=7d&q=%E5%BC%A0', {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(((await searched.json()) as { total: number }).total).toBe(1);
  });

  test('an unauthenticated caller gets 401', async () => {
    expect((await (await app())('/admin/usage/users?range=7d')).status).toBe(401);
  });

  test('a role without usage:view gets 403', async () => {
    const token = await signToken({ sub: users.u1, orgId: 'o1', roles: ['dev'] });
    const res = await (await app())('/admin/usage/users?range=7d', {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(403);
  });

  test('an unrecognized range returns 400 and a bad sort returns 400', async () => {
    const token = await signToken({ sub: users.u1, orgId: 'o1', roles: ['super_admin'] });
    const h = { authorization: `Bearer ${token}` };
    expect((await (await app())('/admin/usage/users?range=garbage', { headers: h })).status).toBe(400);
    expect((await (await app())('/admin/usage/users?range=7d&sort=sideways', { headers: h })).status).toBe(400);
  });

  test('a hugely oversized page value is clamped, not crashed', async () => {
    const token = await signToken({ sub: users.u1, orgId: 'o1', roles: ['super_admin'] });
    const res = await (await app())('/admin/usage/users?range=7d&page=99999999999999999999', {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { total: number }).total).toBe(3);
  });
});

describe('GET /admin/usage/users/:userId', () => {
  // Returns a request-making thunk so each call site reads `app()(...)` and
  // the dynamic import stays out of the assertions.
  async function app(): Promise<(path: string, init?: RequestInit) => Promise<Response>> {
    const a = new Hono();
    const { adminUsageRoutes } = await import('../../src/routes/admin/usage');
    a.route('/', adminUsageRoutes);
    return async (path, init) => a.request(path, init);
  }

  beforeEach(async () => {
    await testPool.query(
      `UPDATE users SET extra_roles='["super_admin"]' WHERE org_id='o1' AND username='zhangwei'`,
    );
  });

  test('returns daily and by_model with a length that matches the resolved range', async () => {
    const token = await signToken({ sub: users.u1, orgId: 'o1', roles: ['super_admin'] });
    const res = await (await app())(`/admin/usage/users/${users.u1}?range=7d`, {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      range: string;
      from: string;
      to: string;
      timezone: string;
      user: { user_id: string };
      daily: { date: string; tokens: number }[];
      by_model: unknown[];
      unaccounted_calls: number;
    };
    expect(body.range).toBe('7d');
    expect(body.timezone).toBe('UTC');
    expect(body.user.user_id).toBe(users.u1);
    // range=7d is today plus the six days before it — seven days, and the
    // drawer draws one bar slot per day, so the count must be exactly seven.
    expect(body.daily).toHaveLength(7);
    for (const d of body.daily) expect(d.tokens).toBe(0);
    expect(body.by_model).toEqual([]);
    expect(body.unaccounted_calls).toBe(0);
  });

  test('an unknown user id returns 404', async () => {
    const token = await signToken({ sub: users.u1, orgId: 'o1', roles: ['super_admin'] });
    const res = await (await app())('/admin/usage/users/nobody?range=7d', {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(404);
  });

  test('another org\'s member returns 404, not another org\'s data', async () => {
    await testPool.query(`INSERT INTO orgs(id,name) VALUES ('o2','Other')`);
    const outsider = await authService.createUser({ orgId: 'o2', username: 'outsider', password: 'pw12345' });
    const token = await signToken({ sub: users.u1, orgId: 'o1', roles: ['super_admin'] });
    const res = await (await app())(`/admin/usage/users/${outsider.id}?range=7d`, {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(404);
  });

  test('an unauthenticated caller gets 401 and a bad range gets 400', async () => {
    expect((await (await app())(`/admin/usage/users/${users.u1}?range=7d`)).status).toBe(401);
    const token = await signToken({ sub: users.u1, orgId: 'o1', roles: ['super_admin'] });
    const res = await (await app())(`/admin/usage/users/${users.u1}?range=garbage`, {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(400);
  });
});