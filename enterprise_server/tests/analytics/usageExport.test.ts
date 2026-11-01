import '../helpers/setupEnv';

import { beforeEach, describe, expect, test, vi } from 'vitest';
vi.mock('../../src/db/pool', async () => {
  const td = await import('../../src/db/testDb');
  return { pool: td.testPool };
});
import { Hono } from 'hono';

import { queryModels, queryModelsAll, queryUsers, queryUsersAll } from '../../src/analytics/usage';
import { authService } from '../../src/auth/authService';
import { signToken } from '../../src/auth/jwt';
import { roleResolver } from '../../src/auth/roleResolver';
import { resetSchema, runMigrations, testPool } from '../../src/db/testDb';

const FROM = new Date('2026-03-01T00:00:00Z');
const TO = new Date('2026-03-08T00:00:00Z');

// provider_keys.created_by and token_usage.user_id both reference users(id),
// so the roster is built from the UUID authService returns rather than the
// literal 'u1' the brief wrote. u3 has no display_name on purpose: the CSV's
// 用户名称 column falls back to the username, and last-used is the em-dash
// case.
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

// A role that grants usage:view and nothing else. Builtin roles cannot
// express this (super_admin short-circuits every gate, auditor carries
// usage:export after migration 052), so the export-vs-view distinction the
// test is about is unreachable without a custom role. `roleResolver`
// memoises the roles table for 30s, so the cache is dropped right after the
// insert — without it every assertion below would read a stale map and the
// 403 would be an accident rather than the gate working.
async function seedViewOnlyRole(): Promise<void> {
  await testPool.query(
    `INSERT INTO roles(id, name, data_scope, permissions)
     VALUES ('r-view-only', 'usage_view_only', 'org_wide', '["usage:view"]'::jsonb)`,
  );
  await testPool.query(`UPDATE users SET extra_roles='["usage_view_only"]' WHERE id=$1`, [users.u2]);
  roleResolver.invalidate();
}

async function seedCatalog(provider: string, model: string): Promise<void> {
  await testPool.query(
    `INSERT INTO model_catalog(id, org_id, provider_key_id, provider, model, display_name)
     VALUES ($1, 'o1', $2, $3, $4, $5) ON CONFLICT (org_id, provider_key_id, model) DO NOTHING`,
    [`mc:${provider}:${model}`, `pk-${provider}`, provider, model, model],
  );
}

/** One token_usage row at `<day>T10:00:00Z`, total_tokens set verbatim (NOT
 * doubled) so the numeric assertions read as written. */
async function usage(
  userId: string,
  provider: string,
  model: string,
  tokens: number,
  day: string,
  opts?: { modelId?: string; missing?: boolean },
): Promise<void> {
  await testPool.query(
    `INSERT INTO token_usage(org_id,user_id,model_id,provider,token_in,token_out,total_tokens,result_code,quota_window_date,usage_missing,ts)
     VALUES ('o1',$1,$2,$3,$4,0,$4,200,'2026-03-01',$5,$6)`,
    [userId, opts?.modelId ?? `mc:${provider}:${model}`, provider, tokens, opts?.missing ?? false, `${day}T10:00:00Z`],
  );
}

/** `range=7d` resolves against the real clock, so a route-level row has to
 * land today rather than in the frozen March window the unit tests use. */
function today(): string {
  return new Date().toISOString().slice(0, 10);
}

/**
 * `YYYY-MM-DD` → `MM/DD`, the date half of the export's `MM/DD HH:mm`
 * column.
 *
 * Asserting against a literal date here would time-lock the test: `today()`
 * reads the real clock, so the file only passes on the day it was written.
 * Deriving from the same `day` the row was seeded with keeps it correct on
 * whatever date the suite runs, which is the whole point of a test that is
 * meant to still be green next month.
 */
function md(day: string): string {
  return day.slice(5).replace('-', '/');
}

async function app(): Promise<(path: string, init?: RequestInit) => Promise<Response>> {
  const a = new Hono();
  const { adminUsageRoutes } = await import('../../src/routes/admin/usage');
  a.route('/', adminUsageRoutes);
  return async (path, init) => a.request(path, init);
}

async function superToken(): Promise<string> {
  return signToken({ sub: users.u1, orgId: 'o1', roles: ['super_admin'] });
}

function viewOnlyToken(): Promise<string> {
  return signToken({ sub: users.u2, orgId: 'o1', roles: ['usage_view_only'] });
}

/** Strip the BOM and split into physical CRLF lines. */
function lines(body: string): string[] {
  return body.replace(/^\uFEFF/, '').trim().split('\r\n');
}

/**
 * The BOM is asserted on the BYTES, not on `res.text()`.
 *
 * The WHATWG decode algorithm strips a leading U+FEFF, so reading the
 * response as text yields `统计范围：…` with the BOM already gone — a
 * `charCodeAt(0) === 0xfeff` assertion on the decoded string would be
 * asserting an artifact of the test client, not the file Excel receives.
 * Byte 0 is what decides the character set when the file is opened, so that
 * is what is checked: EF BB BF at the front of the array buffer.
 */
async function bomBytes(res: Response): Promise<number[]> {
  return [...new Uint8Array(await res.clone().arrayBuffer())].slice(0, 3);
}

describe('GET /admin/usage/export.csv — models', () => {
  test('emits every merged row, not just the visible page', async () => {
    for (const [m, tk] of [['a', 1], ['b', 2], ['c', 3], ['d', 4], ['e', 5]] as const) {
      await seedCatalog('anthropic', m);
      await usage(users.u1, 'anthropic', m, tk * 100, today());
    }
    const token = await superToken();
    const res = await (await app())('/admin/usage/export.csv?range=7d&tab=models', {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(200);
    expect(await bomBytes(res)).toEqual([0xef, 0xbb, 0xbf]);
    const out = lines(await res.text());
    expect(out[0]).toBe('统计范围：近 7 天');
    expect(out[1]).toBe('模型提供商,模型名称,模型用量(tokens),调用次数');
    expect(out.slice(2)).toHaveLength(5);
    expect(res.headers.get('x-export-count')).toBe('5');
    // Sorted by tokens desc — the same order the table renders, so a reader
    // scanning both sees the same sequence.
    expect(out[2]).toBe('anthropic,e,500,1');
  });

  test('the export is not capped by the table page size', async () => {
    for (const [m, tk] of [['a', 1], ['b', 2], ['c', 3], ['d', 4], ['e', 5]] as const) {
      await seedCatalog('anthropic', m);
      await usage(users.u1, 'anthropic', m, tk * 100, today());
    }
    const token = await superToken();
    const hdr = { authorization: `Bearer ${token}` };

    // The table asked for two rows and gets two. The CSV, from the same data
    // and the same range, is not limited to two — this is the whole reason
    // queryModelsAll exists, and a shared pageSize would fail here.
    const table = await (await app())('/admin/usage/models?range=7d&pageSize=2', { headers: hdr });
    expect(((await table.json()) as { items: unknown[] }).items).toHaveLength(2);

    const csv = await (await app())('/admin/usage/export.csv?range=7d&tab=models', { headers: hdr });
    expect(lines(await csv.text()).slice(2)).toHaveLength(5);
  });

  test('the export row count matches the models list total', async () => {
    // Five merged rows plus one catalog model with NO calls in range. Both
    // matter: with a single seeded row a truncation at N>1 would still agree,
    // and a catalog-only row is the one the join's FULL side produces — it is
    // a real row in the export and in the table's total, and dropping it is
    // exactly the kind of quiet divergence this assertion exists to catch.
    for (const [m, tk] of [['a', 100], ['b', 200], ['c', 300], ['d', 400], ['e', 500]] as const) {
      await seedCatalog('anthropic', m);
      await usage(users.u1, 'anthropic', m, tk, today());
    }
    await seedCatalog('deepseek', 'never-called');

    const token = await superToken();
    const hdr = { authorization: `Bearer ${token}` };
    const csv = await (await app())('/admin/usage/export.csv?range=7d&tab=models', { headers: hdr });
    const list = await (await app())('/admin/usage/models?range=7d', { headers: hdr });
    const total = ((await list.json()) as { total: number }).total;

    expect(total).toBe(6);
    expect(csv.headers.get('x-export-count')).toBe(String(total));
    // And the file itself carries every one, the zero row included.
    const rows = lines(await csv.text()).slice(2);
    expect(rows).toHaveLength(6);
    expect(rows).toContain('deepseek,never-called,0,0');
    expect(csv.headers.get('x-export-count')).toBe(String(rows.length));
  });

  test('the filename uses the range KEY, ASCII, with the Chinese tail', async () => {
    // Spec §5.4: the filename is `{key}-{…}.csv` so the range portion needs
    // no percent-encoding; the Chinese label is display text (the CSV's first
    // line, the UI toast) and never reaches the filename. Asserting only the
    // `模型用量` tail would pass for either choice, so the `7d-` prefix is
    // pinned too.
    const token = await superToken();
    const res = await (await app())('/admin/usage/export.csv?range=7d&tab=models', {
      headers: { authorization: `Bearer ${token}` },
    });
    const cd = res.headers.get('content-disposition') ?? '';
    expect(cd).toContain("attachment; filename*=UTF-8''");
    expect(cd).toContain('7d-');
    // No label leaked into the name, and no `%20` from a Chinese space.
    expect(decodeURIComponent(cd)).not.toContain('近 7 天');
    expect(cd).toContain('%E6%A8%A1%E5%9E%8B%E7%94%A8%E9%87%8F.csv');
    expect(res.headers.get('content-type')).toBe('text/csv; charset=utf-8');
  });

  test('each range key produces its own ASCII filename', async () => {
    const token = await superToken();
    const hdr = { authorization: `Bearer ${token}` };
    for (const key of ['today', '7d', '30d', 'this_month', 'last_month']) {
      const res = await (await app())(`/admin/usage/export.csv?range=${key}&tab=models`, { headers: hdr });
      expect(decodeURIComponent(res.headers.get('content-disposition') ?? '')).toContain(`${key}-模型用量.csv`);
    }
  });

  test('each of the five range keys renders its own Chinese label', async () => {
    const token = await superToken();
    const hdr = { authorization: `Bearer ${token}` };
    const expected: [string, string][] = [
      ['today', '今天'],
      ['7d', '近 7 天'],
      ['30d', '近 30 天'],
      ['this_month', '本月'],
      ['last_month', '上月'],
    ];
    for (const [key, label] of expected) {
      const res = await (await app())(`/admin/usage/export.csv?range=${key}&tab=models`, { headers: hdr });
      expect(res.status).toBe(200);
      expect(lines(await res.text())[0]).toBe(`统计范围：${label}`);
    }
  });
});

describe('GET /admin/usage/export.csv — users', () => {
  test('carries the range line and an em dash for a member who never called', async () => {
    const token = await superToken();
    const res = await (await app())('/admin/usage/export.csv?range=7d&tab=users', {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(200);
    const out = lines(await res.text());
    expect(out[0]).toBe('统计范围：近 7 天');
    expect(out[1]).toBe('用户名称,部门,用量,最近使用时间');
    expect(out.slice(2)).toHaveLength(3);
    // u3 never called: zero tokens and an em dash rather than a blank or a
    // raw timestamp — the same shape the table renders.
    expect(out.find((l) => l.startsWith('wangwu'))).toBe('wangwu,,0,—');
    expect(out.find((l) => l.startsWith('张伟'))).toBe('张伟,,0,—');
  });

  test('reports usage and last-used for a member who did call', async () => {
    const day = today();
    await seedCatalog('anthropic', 'opus');
    await usage(users.u1, 'anthropic', 'opus', 400, day);
    const token = await superToken();
    const res = await (await app())('/admin/usage/export.csv?range=7d&tab=users', {
      headers: { authorization: `Bearer ${token}` },
    });
    const row = lines(await res.text()).find((l) => l.startsWith('张伟'))!;
    // Spec §5.4: MM/DD HH:mm in the ORG's zone, not a raw ISO instant. The
    // org zone is UTC here, so the seeded 10:00Z reads back as 10:00.
    //
    // The date is derived from `day`, never written as a literal: `today()`
    // reads the real clock, so a hardcoded `10/22` would go red on any
    // morning after this was written — a failure that has nothing to do with
    // the code under test and lands on a branch nobody is watching.
    expect(row).toBe(`张伟,,400,${md(day)} 10:00`);
  });

  test('last-used is formatted in the org timezone, not UTC', async () => {
    await testPool.query(`UPDATE orgs SET timezone='Asia/Shanghai' WHERE id='o1'`);
    const day = today();
    await seedCatalog('anthropic', 'opus');
    await usage(users.u1, 'anthropic', 'opus', 400, day);
    const token = await superToken();
    const res = await (await app())('/admin/usage/export.csv?range=7d&tab=users', {
      headers: { authorization: `Bearer ${token}` },
    });
    const row = lines(await res.text()).find((l) => l.startsWith('张伟'))!;
    // 10:00Z is 18:00 the same day in UTC+8. Formatting in UTC would print
    // 10:00 and quietly disagree with the window the range resolver built in
    // the org's own zone. Date derived, not literal — see the test above.
    expect(row).toBe(`张伟,,400,${md(day)} 18:00`);
  });

  test('honours the search filter and the sort direction', async () => {
    await seedCatalog('anthropic', 'opus');
    await usage(users.u1, 'anthropic', 'opus', 900, today());
    await usage(users.u2, 'anthropic', 'opus', 100, today());
    const token = await superToken();
    const hdr = { authorization: `Bearer ${token}` };

    const searched = await (await app())('/admin/usage/export.csv?range=7d&tab=users&q=%E5%BC%A0', { headers: hdr });
    const searchedRows = lines(await searched.text()).slice(2);
    expect(searchedRows).toHaveLength(1);
    expect(searchedRows[0]).toContain('张伟');
    expect(searched.headers.get('x-export-count')).toBe('1');

    // asc puts the heaviest consumer last, matching the table's ordering.
    const asc = await (await app())('/admin/usage/export.csv?range=7d&tab=users&sort=asc', { headers: hdr });
    expect(lines(await asc.text()).slice(2)[2]).toContain('张伟');
  });

  test('the users export row count matches the users list total', async () => {
    await seedCatalog('anthropic', 'opus');
    await usage(users.u1, 'anthropic', 'opus', 100, today());
    const token = await superToken();
    const hdr = { authorization: `Bearer ${token}` };
    const csv = await (await app())('/admin/usage/export.csv?range=7d&tab=users', { headers: hdr });
    const list = await (await app())('/admin/usage/users?range=7d&pageSize=1', { headers: hdr });
    expect(csv.headers.get('x-export-count')).toBe(String(((await list.json()) as { total: number }).total));
  });
});

describe('GET /admin/usage/export.csv — gating', () => {
  test('export needs usage:export, not merely usage:view', async () => {
    await seedViewOnlyRole();
    const token = await viewOnlyToken();
    const res = await (await app())('/admin/usage/export.csv?range=7d&tab=models', {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(403);
  });

  test('the models list still succeeds for that same caller', async () => {
    // Same token as the 403 above. Without this the previous test would also
    // pass for a caller who is simply unauthenticated to every usage route —
    // it has to prove the gate is per-permission-point, not per-feature.
    await seedViewOnlyRole();
    const token = await viewOnlyToken();
    const res = await (await app())('/admin/usage/models?range=7d', {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(200);
  });

  test('a role holding only usage:export can export', async () => {
    // The third permission case, and the only one that can see the mount
    // order. A blanket `use('/admin/usage/*', requirePermission(UsageView))`
    // registered ABOVE the export route gates it with the wrong point and
    // refuses this caller — while every other test in this file still passes,
    // because their only non-super_admin caller holds usage:view and so
    // satisfies both halves of either ordering. Verified: mounting that
    // blanket middleware turns exactly this test red and nothing else.
    //
    // It also pins the intended semantics rather than an accident of
    // ordering: bulk extraction is its own permission, and holding it does
    // not have to imply being able to read the table on screen.
    await testPool.query(
      `INSERT INTO roles(id, name, data_scope, permissions)
       VALUES ('r-export-only', 'usage_export_only', 'org_wide', '["usage:export"]'::jsonb)`,
    );
    roleResolver.invalidate();
    const token = await signToken({ sub: users.u1, orgId: 'o1', roles: ['usage_export_only'] });

    const res = await (await app())('/admin/usage/export.csv?range=7d&tab=models', {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(200);
  });

  test('the same export-only caller cannot read the table', async () => {
    await testPool.query(
      `INSERT INTO roles(id, name, data_scope, permissions)
       VALUES ('r-export-only', 'usage_export_only', 'org_wide', '["usage:export"]'::jsonb)`,
    );
    roleResolver.invalidate();
    const token = await signToken({ sub: users.u1, orgId: 'o1', roles: ['usage_export_only'] });

    expect((await (await app())('/admin/usage/models?range=7d', {
      headers: { authorization: `Bearer ${token}` },
    })).status).toBe(403);
  });

  test('a role without any usage point is refused on both', async () => {
    const token = await signToken({ sub: users.u1, orgId: 'o1', roles: ['dev'] });
    const hdr = { authorization: `Bearer ${token}` };
    expect((await (await app())('/admin/usage/export.csv?range=7d&tab=models', { headers: hdr })).status).toBe(403);
    expect((await (await app())('/admin/usage/models?range=7d', { headers: hdr })).status).toBe(403);
  });

  test('an unauthenticated caller gets 401', async () => {
    expect((await (await app())('/admin/usage/export.csv?range=7d&tab=models')).status).toBe(401);
  });

  test('?orgId is ignored — the org comes from the token, never the query string', async () => {
    // Nothing else pins this: a `c.req.query('orgId')` spliced into either
    // query would still pass every other test in this file, because they all
    // run as org o1. Here o2 has its own models and its own members, so a
    // successful injection would leak them into o1's export.
    await testPool.query(`INSERT INTO orgs(id,name) VALUES ('o2','Other')`);
    const { id: outsider } = await authService.createUser({ orgId: 'o2', username: 'outsider', password: 'pw12345', displayName: '外人' });
    // provider_keys before model_catalog: the catalog row carries a FK to it.
    await testPool.query(
      `INSERT INTO provider_keys(id,org_id,provider,api_key_encrypted,created_by)
       VALUES ('pk-o2','o2','anthropic','z',$1)`,
      [outsider],
    );
    await testPool.query(
      `INSERT INTO model_catalog(id, org_id, provider_key_id, provider, model, display_name)
       VALUES ('mc:o2:opus', 'o2', 'pk-o2', 'anthropic', 'o2secret', 'o2secret')`,
    );
    await testPool.query(
      `INSERT INTO token_usage(org_id,user_id,model_id,provider,token_in,token_out,total_tokens,result_code,quota_window_date,usage_missing,ts)
       VALUES ('o2',$1,'mc:o2:opus','anthropic',777,0,777,200,'2026-03-01',false,$2)`,
      [outsider, `${today()}T10:00:00Z`],
    );

    const token = await superToken();
    const hdr = { authorization: `Bearer ${token}` };
    const csv = await (await app())('/admin/usage/export.csv?range=7d&tab=models&orgId=o2', { headers: hdr });
    expect(csv.status).toBe(200);
    const models = lines(await csv.text()).slice(2);
    expect(models.some((l) => l.includes('o2secret'))).toBe(false);

    const usersCsv = await (await app())('/admin/usage/export.csv?range=7d&tab=users&orgId=o2', { headers: hdr });
    expect(lines(await usersCsv.text()).slice(2).some((l) => l.includes('外人'))).toBe(false);

    // Same question asked of the two list routes, which share the claims.
    const modelsList = await (await app())('/admin/usage/models?range=7d&orgId=o2', { headers: hdr });
    expect(JSON.stringify(await modelsList.json())).not.toContain('o2secret');
    const usersList = await (await app())('/admin/usage/users?range=7d&orgId=o2', { headers: hdr });
    expect(JSON.stringify(await usersList.json())).not.toContain('外人');
  });

  test('an unrecognized range or tab returns 400', async () => {
    const token = await superToken();
    const hdr = { authorization: `Bearer ${token}` };
    expect((await (await app())('/admin/usage/export.csv?range=garbage&tab=models', { headers: hdr })).status).toBe(400);
    expect((await (await app())('/admin/usage/export.csv?range=7d&tab=sideways', { headers: hdr })).status).toBe(400);
  });

  test('the route is mounted ahead of the usage:view middleware', async () => {
    // Registration order, asserted against the source: Hono runs matching
    // middleware in the order it was added, so a blanket
    // `use('/admin/usage/*', requirePermission(UsageView))` registered above
    // this route would answer 403 for a caller who legitimately holds
    // usage:export, and the behavioural tests above would go red.
    const fs = await import('node:fs');
    const { fileURLToPath } = await import('node:url');
    const src = fs.readFileSync(fileURLToPath(new URL('../../src/routes/admin/usage.ts', import.meta.url)), 'utf8');
    const exportAt = src.indexOf("'/admin/usage/export.csv'");
    const modelsAt = src.indexOf("'/admin/usage/models'");
    expect(exportAt).toBeGreaterThan(-1);
    expect(exportAt).toBeLessThan(modelsAt);
  });
});

describe('queryModelsAll / queryUsersAll', () => {
  // Captures the SQL each function sends while still running it, so the
  // window claim is checked against the statement that actually executes
  // rather than against a re-implementation of it.
  async function capture(fn: () => Promise<unknown>): Promise<string[]> {
    const real = testPool.query.bind(testPool);
    const seen: string[] = [];
    const spy = vi.spyOn(testPool, 'query').mockImplementation(async (sql: string, params?: unknown[]) => {
      seen.push(sql);
      return real(sql, params as never[]);
    });
    try {
      await fn();
    } finally {
      spy.mockRestore();
    }
    return seen;
  }

  /** Remove the paging window so the paged and unbounded statements can be
   * compared as whole SQL rather than clause by clause. */
  function stripWindow(sql: string): string {
    return sql.replace(/LIMIT \$\d+ OFFSET \$\d+/, '').trim();
  }

  test('the export statement drops LIMIT/OFFSET and shares the paged SQL verbatim', async () => {
    await seedCatalog('anthropic', 'a');
    await usage(users.u1, 'anthropic', 'a', 100, '2026-03-01');

    const paged = await capture(() =>
      queryModels({ orgId: 'o1', from: FROM, to: TO, page: 1, pageSize: 50 }),
    );
    const all = await capture(() => queryModelsAll({ orgId: 'o1', from: FROM, to: TO }));

    const pagedPage = paged.find((s) => /ORDER BY/.test(s) && /LIMIT/.test(s))!;
    const allPage = all.find((s) => /ORDER BY/.test(s))!;
    expect(pagedPage).toMatch(/LIMIT \$4 OFFSET \$5/);
    expect(allPage).not.toMatch(/LIMIT/);
    expect(allPage).not.toMatch(/OFFSET/);
    // Strip the window from the paged statement and the two are byte-equal:
    // one template, two windows. This is the anti-drift assertion — a second
    // copy of the SQL could gain a predicate or lose a tiebreaker and every
    // count-based test above would still pass while the file quietly diverged.
    expect(stripWindow(allPage)).toBe(stripWindow(pagedPage));
  });

  test('the users export statement drops LIMIT/OFFSET too', async () => {
    await seedCatalog('anthropic', 'a');
    await usage(users.u1, 'anthropic', 'a', 100, '2026-03-01');

    const paged = await capture(() =>
      queryUsers({ orgId: 'o1', from: FROM, to: TO, sort: 'desc', page: 1, pageSize: 8 }),
    );
    const all = await capture(() =>
      queryUsersAll({ orgId: 'o1', from: FROM, to: TO, sort: 'desc' }),
    );

    const pagedPage = paged.find((s) => /ORDER BY/.test(s) && /LIMIT/.test(s))!;
    const allPage = all.find((s) => /ORDER BY/.test(s))!;
    expect(pagedPage).toMatch(/LIMIT \$5 OFFSET \$6/);
    expect(allPage).not.toMatch(/LIMIT/);
    expect(allPage).not.toMatch(/OFFSET/);
    expect(stripWindow(allPage)).toBe(stripWindow(pagedPage));
  });

  test('numbers are coerced from the pg-driver string shape', async () => {
    // pglite hands int8 back as a JS number, so a live assertion here would
    // pass even if the Number() calls were dropped. The pool is stubbed to
    // return strings — the shape `pg` produces — which is the only way this
    // assertion can fail.
    const spy = vi.spyOn(testPool, 'query');
    spy.mockImplementation(async (sql: string) => {
      // Split by statement: the models and users exports share the
      // `/ORDER BY/` shape but not the columns. Collapsing them would have
      // this test pass for the wrong reason.
      if (/roster AS/.test(sql)) {
        return {
          rows: [
            {
              user_id: 'u1',
              username: 'zhangwei',
              display_name: '张伟',
              department_name: null,
              total_tokens: '4000000000',
              last_used_at: null,
            },
          ],
          rowCount: 1,
        };
      }
      if (/ORDER BY/.test(sql)) {
        return {
          rows: [{ provider: 'anthropic', model: 'a', display_name: 'a', total_tokens: '4000000000', call_count: '7' }],
          rowCount: 1,
        };
      }
      return { rows: [{ roster_total: '3', missing_total: '0' }], rowCount: 1 };
    });
    try {
      const models = await queryModelsAll({ orgId: 'o1', from: FROM, to: TO });
      expect(typeof models[0].total_tokens).toBe('number');
      expect(typeof models[0].call_count).toBe('number');
      expect(models[0].total_tokens).toBe(4_000_000_000);
      expect(models[0].call_count).toBe(7);

      const members = await queryUsersAll({ orgId: 'o1', from: FROM, to: TO, sort: 'desc' });
      expect(typeof members[0].total_tokens).toBe('number');
      expect(members[0].total_tokens).toBe(4_000_000_000);
      expect(members[0].last_used_at).toBeNull();
    } finally {
      spy.mockRestore();
    }
  });

  test('the export row set is the full roster, past any page', async () => {
    await seedCatalog('anthropic', 'a');
    await usage(users.u1, 'anthropic', 'a', 100, '2026-03-01');
    const all = await queryUsersAll({ orgId: 'o1', from: FROM, to: TO, sort: 'desc' });
    expect(all.map((u) => u.user_id).sort()).toEqual([users.u1, users.u2, users.u3].sort());
  });
});