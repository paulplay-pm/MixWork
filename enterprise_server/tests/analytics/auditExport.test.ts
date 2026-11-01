import '../helpers/setupEnv';

import { beforeEach, describe, expect, test, vi } from 'vitest';
vi.mock('../../src/db/pool', async () => {
  const td = await import('../../src/db/testDb');
  return { pool: td.testPool };
});
import { Hono } from 'hono';

import { authService } from '../../src/auth/authService';
import { signToken } from '../../src/auth/jwt';
import { roleResolver } from '../../src/auth/roleResolver';
import { resetSchema, runMigrations, testPool } from '../../src/db/testDb';
import { AuditAction } from '../../src/shared/enterpriseServerConstants';

// users.id is TEXT but provider/auth paths expect the UUID authService mints,
// and the CSV resolves a display name through it — so the roster is built from
// real createUser calls rather than the literal 'u1' a brief would write.
const users: { zhang: string; li: string } = { zhang: '', li: '' };

/**
 * `YYYY-MM-DD` → `YYYY/MM/DD`, the date half of the export's
 * `YYYY/MM/DD HH:mm:ss` column.
 *
 * Derived from the same `day` the row was seeded with, never written as a
 * literal: the custom range below is `[today, today]`, so a hardcoded date in
 * the expectation would go red on the first morning after this was written.
 */
function ymd(day: string): string {
  return day.replace(/-/g, '/');
}

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

/** The single-day custom window every export test in this file filters on. */
function todayRange(): string {
  return `range=custom&from=${today()}&to=${today()}`;
}

beforeEach(async () => {
  await resetSchema();
  await runMigrations();
  await testPool.query(`INSERT INTO orgs(id,name) VALUES ('o1','Org One'),('o2','Org Two')`);
  users.zhang = (await authService.createUser({ orgId: 'o1', username: 'zhangwei', password: 'pw12345', displayName: '张伟' })).id;
  users.li = (await authService.createUser({ orgId: 'o1', username: 'lina', password: 'pw12345', displayName: '李娜' })).id;
});

async function event(opts: {
  orgId?: string;
  userId?: string | null;
  action: string;
  targetType?: string | null;
  targetId?: string | null;
  payload?: unknown;
  ts?: string;
}): Promise<void> {
  await testPool.query(
    `INSERT INTO audit_events(org_id,user_id,action,target_type,target_id,payload,ts)
     VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [
      opts.orgId ?? 'o1',
      opts.userId ?? null,
      opts.action,
      opts.targetType ?? null,
      opts.targetId ?? null,
      opts.payload === undefined ? null : JSON.stringify(opts.payload),
      opts.ts ?? `${today()}T10:00:00Z`,
    ],
  );
}

/** N same-window events in ONE statement. Seeding the truncation fixture
 *  through `event()` would be >10,000 round trips against pglite; the route's
 *  behaviour under test is the header arithmetic, not the insert. */
async function seedMany(n: number): Promise<void> {
  await testPool.query(
    `INSERT INTO audit_events(org_id,user_id,action,target_type,target_id,ts)
     SELECT 'o1', NULL, 'dept_create', 'dept', 'd-' || g, $1::timestamptz
     FROM generate_series(1, $2) g`,
    [`${today()}T10:00:00Z`, n],
  );
}

async function login(opts: { userId?: string | null; result: 'success' | 'failed'; ts?: string }): Promise<void> {
  await testPool.query(
    `INSERT INTO login_events(id,org_id,user_id,ip,device,result,ts)
     VALUES ($1,'o1',$2,'10.0.0.9','chrome',$3,$4)`,
    [crypto.randomUUID(), opts.userId ?? null, opts.result, opts.ts ?? `${today()}T10:00:00Z`],
  );
}

async function app(): Promise<(path: string, init?: RequestInit) => Promise<Response>> {
  const a = new Hono();
  const { adminAuditRoutes } = await import('../../src/routes/admin/audit');
  a.route('/', adminAuditRoutes);
  return async (path, init) => a.request(path, init);
}

// The export's real batch size, read from the route module rather than copied
// here: a literal 10_000 in this file would keep passing if the constant were
// ever retuned, long after it had stopped exercising the cap at all.
const { EXPORT_PAGE_SIZE } = await import('../../src/routes/admin/audit');

function superToken(): Promise<string> {
  return signToken({ sub: users.zhang, orgId: 'o1', roles: ['super_admin'] });
}

function tokenFor(role: string): Promise<string> {
  return signToken({ sub: users.zhang, orgId: 'o1', roles: [role] });
}

async function seedRole(id: string, name: string, permissions: string[]): Promise<void> {
  await testPool.query(
    `INSERT INTO roles(id, name, data_scope, permissions) VALUES ($1,$2,'org_wide',$3::jsonb)`,
    [id, name, JSON.stringify(permissions)],
  );
  // roleResolver memoises the roles table for 30s; without dropping the cache
  // every non-super_admin assertion below would read a stale map and pass for
  // the wrong reason.
  roleResolver.invalidate();
}

/**
 * Strip the BOM and split into physical CRLF lines.
 *
 * `Response.text()` drops a leading U+FEFF per the WHATWG decode algorithm, so
 * this can never see it — that is why `bomBytes` asserts on the array buffer
 * instead, which is what Excel reads byte 0 of.
 */
function lines(body: string): string[] {
  return body.replace(/^\uFEFF/, '').trim().split('\r\n');
}

/** Byte 0 is what decides the character set when Excel opens the file, so that
 * is what is checked. EF BB BF at the front of the array buffer. */
async function bomBytes(res: Response): Promise<number[]> {
  return [...new Uint8Array(await res.clone().arrayBuffer())].slice(0, 3);
}

/**
 * RFC 4180 split, so "stays in one column" is measured by the rule a
 * spreadsheet applies. `split(',')` would call a quoted JSON payload two or
 * three columns — which is the exact bug the legacy `.replace(/,/g,'\\,')`
 * escaping produced, and the reason this parser exists rather than a count.
 */
function parseCsv(body: string): string[][] {
  const text = body.replace(/^\uFEFF/, '');
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (quoted) {
      if (ch !== '"') cell += ch;
      else if (text[i + 1] === '"') { cell += '"'; i++; }
      else quoted = false;
      continue;
    }
    if (ch === '"') quoted = true;
    else if (ch === ',') { row.push(cell); cell = ''; }
    else if (ch === '\r') { /* part of the CRLF pair */ }
    else if (ch === '\n') { row.push(cell); rows.push(row); row = []; cell = ''; }
    else cell += ch;
  }
  row.push(cell);
  rows.push(row);
  return rows;
}

describe('GET /admin/audit/export.csv — shape', () => {
  test('the export has a BOM, a range line, and the six documented columns', async () => {
    await event({ userId: users.zhang, action: AuditAction.UserDisable, targetType: 'user', targetId: 'u-x' });
    const res = await (await app())(`/admin/audit/export.csv?${todayRange()}`, {
      headers: { authorization: `Bearer ${await superToken()}` },
    });

    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('text/csv; charset=utf-8');
    expect(await bomBytes(res)).toEqual([0xef, 0xbb, 0xbf]);

    const out = lines(await res.text());
    expect(out[0]).toBe(`统计范围：自定义 ${today()} 至 ${today()}`);
    expect(out[1]).toBe('时间,用户,操作,对象类型,对象ID,载荷');
    expect(out.slice(2)).toHaveLength(1);
    expect(res.headers.get('x-export-count')).toBe('1');
  });

  test('each preset range key renders its own Chinese label', async () => {
    const hdr = { authorization: `Bearer ${await superToken()}` };
    const expected: [string, string][] = [
      ['today', '今天'],
      ['7d', '近 7 天'],
      ['30d', '近 30 天'],
      ['this_month', '本月'],
      ['last_month', '上月'],
    ];
    for (const [key, label] of expected) {
      const res = await (await app())(`/admin/audit/export.csv?range=${key}`, { headers: hdr });
      expect(res.status, key).toBe(200);
      expect(lines(await res.text())[0]).toBe(`统计范围：${label}`);
    }
  });

  test('a custom range names the days it covers, not just 「自定义」', async () => {
    // These files get archived by compliance staff who will not reopen the
    // page, and 「自定义」 alone does not say which window was exported.
    const res = await (await app())(`/admin/audit/export.csv?${todayRange()}`, {
      headers: { authorization: `Bearer ${await superToken()}` },
    });
    expect(lines(await res.text())[0]).toBe(`统计范围：自定义 ${today()} 至 ${today()}`);
  });

  test('the filename uses the range KEY, ASCII, with the Chinese tail', async () => {
    // Spec §5.4: `{key}-{…}.csv`. The key needs no percent-encoding; the
    // Chinese label is display text and belongs in the file's first line. A
    // 「近 7 天-审计记录.csv」 name encodes to 66 characters against 43 for
    // `7d-审计记录.csv`, and the space becomes %20.
    const res = await (await app())('/admin/audit/export.csv?range=7d', {
      headers: { authorization: `Bearer ${await superToken()}` },
    });
    const cd = res.headers.get('content-disposition') ?? '';
    expect(cd).toContain("attachment; filename*=UTF-8''");
    expect(cd).toContain('7d-');
    expect(decodeURIComponent(cd)).not.toContain('近 7 天');
    expect(cd).toContain('%E5%AE%A1%E8%AE%A1%E8%AE%B0%E5%BD%95.csv');
  });
});

describe('GET /admin/audit/export.csv — columns', () => {
  test('the operation column carries the Chinese label, not the code', async () => {
    await event({ userId: users.zhang, action: AuditAction.UserDisable, targetType: 'user', targetId: 'u-x' });
    // Neither code is registered: `POST /audit` lets any authenticated client
    // self-report one, so the meta accessor's raw-value fallback is the case
    // that must still render as the code rather than as a blank cell.
    await event({ userId: users.zhang, action: 'client_invented_action', targetType: 'user', targetId: 'u-y' });

    const res = await (await app())(`/admin/audit/export.csv?${todayRange()}`, {
      headers: { authorization: `Bearer ${await superToken()}` },
    });
    const rows = parseCsv(await res.text()).slice(2);
    const disable = rows.find((r) => r[2] === '停用用户');
    expect(disable).toBeDefined();
    expect(disable![5]).toBe('');
    expect(disable![3]).toBe('用户');
    expect(disable![4]).toBe('u-x');
    expect(disable![1]).toBe('张伟');
    // The unregistered code labels as itself — never blank, never translated.
    expect(rows.some((r) => r[2] === 'client_invented_action')).toBe(true);
    expect(rows.some((r) => r[2] === 'user_disable')).toBe(false);
  });

  test('a payload containing commas and quotes stays in one column', async () => {
    const payload = { note: 'a,b "c"', list: [1, 2], nested: { k: 'x,y' } };
    await event({ userId: users.zhang, action: AuditAction.DeptCreate, targetType: 'dept', targetId: 'd-1', payload });

    const res = await (await app())(`/admin/audit/export.csv?${todayRange()}`, {
      headers: { authorization: `Bearer ${await superToken()}` },
    });
    const raw = await res.text();

    const rows = parseCsv(raw).slice(2);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toHaveLength(6);
    expect(JSON.parse(rows[0]![5]!)).toEqual(payload);

    // The legacy export ran `.replace(/,/g,'\\,')` over the JSON, which DELETED
    // every comma and let the payload spill: with that bug the row would have
    // far more than 6 fields and the JSON would not parse back.
    expect(raw).not.toContain('\\,');
    expect(raw).not.toContain('"note":"a');
  });

  test('an anonymous user and an absent target both render as an em dash', async () => {
    await event({ userId: null, action: AuditAction.LoginFailed });
    const res = await (await app())(`/admin/audit/export.csv?${todayRange()}`, {
      headers: { authorization: `Bearer ${await superToken()}` },
    });
    const rows = parseCsv(await res.text()).slice(2);
    expect(rows).toHaveLength(1);
    expect(rows[0]![1]).toBe('—');
    expect(rows[0]![3]).toBe('—');
    expect(rows[0]![4]).toBe('—');
    expect(rows[0]![2]).toBe('登录失败');
  });

  test('an absent payload is an empty cell, not the four letters null', async () => {
    await event({ userId: users.zhang, action: AuditAction.DeptCreate, targetType: 'dept', targetId: 'd-1' });
    const res = await (await app())(`/admin/audit/export.csv?${todayRange()}`, {
      headers: { authorization: `Bearer ${await superToken()}` },
    });
    expect(parseCsv(await res.text())[2]![5]).toBe('');
  });

  test('the timestamp is YYYY/MM/DD HH:mm:ss in the org timezone', async () => {
    await event({ userId: users.zhang, action: AuditAction.DeptCreate, targetType: 'dept', targetId: 'd-1' });
    const day = today();
    const res = await (await app())(`/admin/audit/export.csv?${todayRange()}`, {
      headers: { authorization: `Bearer ${await superToken()}` },
    });
    // 10:00Z in a UTC org. Spec §5.4's audit shape — note this is NOT the
    // usage export's `MM/dd HH:mm`.
    expect(parseCsv(await res.text())[2]![0]).toBe(`${ymd(day)} 10:00:00`);
  });

  test('the timestamp is formatted in the org zone, not UTC', async () => {
    await testPool.query(`UPDATE orgs SET timezone='Asia/Shanghai' WHERE id='o1'`);
    await event({ userId: users.zhang, action: AuditAction.DeptCreate, targetType: 'dept', targetId: 'd-1' });
    const day = today();
    const res = await (await app())(`/admin/audit/export.csv?${todayRange()}`, {
      headers: { authorization: `Bearer ${await superToken()}` },
    });
    // 10:00Z is 18:00 the same day in UTC+8. Formatting in UTC would print
    // 10:00 and quietly disagree with the window resolveAuditRange built in
    // the org's own zone. Date derived from `day`, never a literal.
    expect(parseCsv(await res.text())[2]![0]).toBe(`${ymd(day)} 18:00:00`);
  });
});

describe('GET /admin/audit/export.csv — rows', () => {
  test('a login_events row is exported, exactly like the table shows it', async () => {
    // includeLogin is hard-coded true on the list too. A failed sign-in
    // writes NO audit_events row, so an export without the union would omit
    // precisely the events an admin opens the audit page to find.
    await login({ userId: users.li, result: 'failed' });
    await event({ userId: users.li, action: AuditAction.DeptCreate, targetType: 'dept', targetId: 'd-1' });

    const res = await (await app())(`/admin/audit/export.csv?${todayRange()}`, {
      headers: { authorization: `Bearer ${await superToken()}` },
    });
    const rows = parseCsv(await res.text()).slice(2);
    expect(rows).toHaveLength(2);
    const loginRow = rows.find((r) => r[2] === '登录')!;
    expect(loginRow[3]).toBe('登录');
    expect(JSON.parse(loginRow[5]!)).toMatchObject({ result: 'failed', ip: '10.0.0.9' });
  });

  test('a successful login is exported once, not once per source table', async () => {
    // The successful sign-in writes an audit_events row AND a login_events
    // row. Two rows here means the dedup the table performs is missing.
    await event({ userId: users.li, action: AuditAction.Login, targetType: null, targetId: null });
    await login({ userId: users.li, result: 'success' });

    const res = await (await app())(`/admin/audit/export.csv?${todayRange()}`, {
      headers: { authorization: `Bearer ${await superToken()}` },
    });
    expect(res.headers.get('x-export-count')).toBe('1');
    expect(parseCsv(await res.text()).slice(2)).toHaveLength(1);
  });

  test('the export honours the filters and is not capped at the page size', async () => {
    for (let i = 0; i < 5; i++) {
      await event({ userId: users.zhang, action: AuditAction.DeptCreate, targetType: 'dept', targetId: `d-${i}` });
    }
    for (let i = 0; i < 3; i++) {
      await event({ userId: users.li, action: AuditAction.UserDisable, targetType: 'user', targetId: `u-${i}` });
    }
    const hdr = { authorization: `Bearer ${await superToken()}` };

    // The table asked for two rows and gets two. The CSV, from the same data
    // and the same range, is not limited to two.
    const table = await (await app())(`/admin/audit?${todayRange()}&pageSize=2`, { headers: hdr });
    const body = (await table.json()) as { items: unknown[]; total: number };
    expect(body.items).toHaveLength(2);
    expect(body.total).toBe(8);

    const all = await (await app())(`/admin/audit/export.csv?${todayRange()}`, { headers: hdr });
    const allRows = parseCsv(await all.text()).slice(2);
    expect(allRows).toHaveLength(8);
    expect(all.headers.get('x-export-count')).toBe('8');

    // Every filter narrows the file the same way it narrows the table.
    const byUser = await (await app())(`/admin/audit/export.csv?${todayRange()}&userId=${users.zhang}`, { headers: hdr });
    expect(parseCsv(await byUser.text()).slice(2)).toHaveLength(5);
    expect(byUser.headers.get('x-export-count')).toBe('5');

    const byAction = await (await app())(`/admin/audit/export.csv?${todayRange()}&action=${AuditAction.UserDisable}`, { headers: hdr });
    expect(parseCsv(await byAction.text()).slice(2)).toHaveLength(3);

    const byTarget = await (await app())(`/admin/audit/export.csv?${todayRange()}&targetType=dept&targetId=d-1`, { headers: hdr });
    const targetRows = parseCsv(await byTarget.text()).slice(2);
    expect(targetRows).toHaveLength(1);
    expect(targetRows[0]![4]).toBe('d-1');
  });

  test('the export row count equals the list total', async () => {
    for (let i = 0; i < 4; i++) {
      await event({ userId: users.li, action: AuditAction.DeptCreate, targetType: 'dept', targetId: `d-${i}` });
    }
    await login({ userId: null, result: 'failed' });

    const hdr = { authorization: `Bearer ${await superToken()}` };
    const csv = await (await app())(`/admin/audit/export.csv?${todayRange()}`, { headers: hdr });
    const list = await (await app())(`/admin/audit?${todayRange()}`, { headers: hdr });
    const total = ((await list.json()) as { total: number }).total;

    expect(total).toBe(5);
    expect(csv.headers.get('x-export-count')).toBe(String(total));
    expect(parseCsv(await csv.text()).slice(2)).toHaveLength(total);
  });

  test('another org is never visible, and ?orgId is ignored', async () => {
    await event({ userId: users.zhang, action: AuditAction.DeptCreate, targetType: 'dept', targetId: 'mine' });
    await event({ orgId: 'o2', action: AuditAction.DeptCreate, targetType: 'dept', targetId: 'theirs' });

    const hdr = { authorization: `Bearer ${await superToken()}` };
    const plain = await (await app())(`/admin/audit/export.csv?${todayRange()}`, { headers: hdr });
    const spoofed = await (await app())(`/admin/audit/export.csv?${todayRange()}&orgId=o2`, { headers: hdr });

    expect(spoofed.headers.get('x-export-count')).toBe(plain.headers.get('x-export-count'));
    const plainBody = await plain.text();
    expect(await spoofed.text()).toBe(plainBody);
    expect(plainBody).not.toContain('theirs');
  });

  test('a window larger than the export batch says so in the headers', async () => {
    // The truncation disclosure. EXPORT_PAGE_SIZE is a REAL cap: this export
    // renders page 1 and stops. A single `x-export-count` cannot express that,
    // because a capped file's count is a plausible-looking number — the
    // reviewer demonstrated this by shrinking the batch to 3 against 5 rows
    // and reading `x-export-count: 3` off a file that was missing two rows.
    //
    // So: count is what the file holds, total is what the query matched, and
    // the test asserts they DIFFER. A header that were always `count` fails
    // here; the mirrored test below fails if it were always `total`.
    const over = EXPORT_PAGE_SIZE + 5;
    await seedMany(over);

    const res = await (await app())(`/admin/audit/export.csv?${todayRange()}`, {
      headers: { authorization: `Bearer ${await superToken()}` },
    });
    expect(res.status).toBe(200);

    // The list sees all of them; the export is the one that is capped.
    const list = await (await app())(`/admin/audit?${todayRange()}`, {
      headers: { authorization: `Bearer ${await superToken()}` },
    });
    expect(((await list.json()) as { total: number }).total).toBe(over);

    expect(res.headers.get('x-export-count')).toBe(String(EXPORT_PAGE_SIZE));
    expect(res.headers.get('x-export-total')).toBe(String(over));
    // The two are not equal, and the count is not the total — which is the
    // entire point of emitting both.
    expect(res.headers.get('x-export-count')).not.toBe(res.headers.get('x-export-total'));

    // And the header matches the file: rows written, not rows claimed.
    const rows = parseCsv(await res.text()).slice(2);
    expect(rows).toHaveLength(EXPORT_PAGE_SIZE);
    expect(rows.every((r) => r.length === 6)).toBe(true);
  });

  test('a window that fits reports count and total as the same number', async () => {
    // The mirror of the test above, and the reason it exists: a header that
    // was hardwired to the query total would pass the capped case and fail
    // this one. Together they pin both ends — `count` is the file, `total` is
    // the query, and neither is a stand-in for the other.
    await seedMany(3);

    const res = await (await app())(`/admin/audit/export.csv?${todayRange()}`, {
      headers: { authorization: `Bearer ${await superToken()}` },
    });
    expect(res.headers.get('x-export-count')).toBe('3');
    expect(res.headers.get('x-export-total')).toBe('3');
    expect(res.headers.get('x-export-count')).toBe(res.headers.get('x-export-total'));
    expect(parseCsv(await res.text()).slice(2)).toHaveLength(3);
  });

  test('an empty window reports zero on both headers', async () => {
    const res = await (await app())(`/admin/audit/export.csv?${todayRange()}`, {
      headers: { authorization: `Bearer ${await superToken()}` },
    });
    expect(res.headers.get('x-export-count')).toBe('0');
    expect(res.headers.get('x-export-total')).toBe('0');
    expect(parseCsv(await res.text()).slice(2)).toHaveLength(0);
  });

  test('rows outside the window are excluded', async () => {
    const old = new Date(Date.now() - 40 * 86400000).toISOString();
    await event({ userId: users.zhang, action: AuditAction.DeptCreate, targetType: 'dept', targetId: 'recent' });
    await event({ userId: users.zhang, action: AuditAction.DeptCreate, targetType: 'dept', targetId: 'old', ts: old });

    const res = await (await app())(`/admin/audit/export.csv?${todayRange()}`, {
      headers: { authorization: `Bearer ${await superToken()}` },
    });
    const rows = parseCsv(await res.text()).slice(2);
    expect(rows).toHaveLength(1);
    expect(rows[0]![4]).toBe('recent');
  });
});

describe('GET /admin/audit/export.csv — the exclude filter', () => {
  test('the file holds exactly the rows the page shows, and says what it left out', async () => {
    for (let i = 0; i < 3; i++) {
      await event({ userId: users.li, action: AuditAction.ProviderCall, targetType: 'model', targetId: `m-${i}` });
    }
    await event({ userId: users.li, action: AuditAction.UserDisable, targetType: 'user', targetId: 'u-x' });

    const hdr = { authorization: `Bearer ${await superToken()}` };
    const plain = await (await app())(`/admin/audit/export.csv?${todayRange()}`, { headers: hdr });
    expect(parseCsv(await plain.text()).slice(2)).toHaveLength(4);
    // Unfiltered exports carry the header as 0 rather than omitting it, so a
    // client never has to branch on its presence.
    expect(plain.headers.get('x-excluded-count')).toBe('0');

    const hidden = await (await app())(
      `/admin/audit/export.csv?${todayRange()}&exclude=${AuditAction.ProviderCall}`,
      { headers: hdr },
    );
    const rows = parseCsv(await hidden.text()).slice(2);
    expect(rows).toHaveLength(1);
    expect(rows[0]![2]).toBe('停用用户');
    expect(rows.some((r) => r[2] === '调用模型服务商')).toBe(false);

    // The count headers describe the FILTERED set, not the unfiltered one. A
    // file that dropped the model calls while still claiming to cover 4 rows
    // would be the exact lie `x-export-count`/`x-export-total` exist to prevent.
    expect(hidden.headers.get('x-export-count')).toBe('1');
    expect(hidden.headers.get('x-export-total')).toBe('1');
    // …and it discloses the omission, because whoever opens this file has not
    // seen the filter that caused it.
    expect(hidden.headers.get('x-excluded-count')).toBe('3');

    // The invariant itself: list and export are the same slice.
    const list = await (await app())(`/admin/audit?${todayRange()}&exclude=${AuditAction.ProviderCall}`, {
      headers: hdr,
    });
    const listed = (await list.json()) as { total: number; excluded: number; items: unknown[] };
    expect(listed.total).toBe(1);
    expect(listed.excluded).toBe(3);
    expect(Number(hidden.headers.get('x-export-total'))).toBe(listed.total);
    expect(Number(hidden.headers.get('x-export-count'))).toBe(listed.items.length);
  });

  test('the exclusion is forwarded alongside the other filters, not instead of them', async () => {
    await event({ userId: users.li, action: AuditAction.ProviderCall, targetType: 'model', targetId: 'm-li' });
    await event({ userId: users.zhang, action: AuditAction.ProviderCall, targetType: 'model', targetId: 'm-zhang' });
    await event({ userId: users.zhang, action: AuditAction.DeptCreate, targetType: 'dept', targetId: 'd-1' });
    const hdr = { authorization: `Bearer ${await superToken()}` };

    const res = await (await app())(
      `/admin/audit/export.csv?${todayRange()}&userId=${users.zhang}&exclude=${AuditAction.ProviderCall}`,
      { headers: hdr },
    );
    const rows = parseCsv(await res.text()).slice(2);
    // 张伟's three rows less the model call he made.
    expect(rows).toHaveLength(1);
    expect(rows[0]![4]).toBe('d-1');
    // The hidden count is scoped to the filters in force: 李娜's model call is
    // not in this request's window and is not counted as dropped.
    expect(res.headers.get('x-excluded-count')).toBe('1');
  });

  test('an emptied exclusion box is no exclusion, and a stray comma is the same request', async () => {
    await event({ userId: users.zhang, action: AuditAction.ProviderCall, targetType: 'model', targetId: 'm-1' });
    await event({ userId: users.zhang, action: AuditAction.DeptCreate, targetType: 'dept', targetId: 'd-1' });

    const hdr = { authorization: `Bearer ${await superToken()}` };
    // What a cleared filter box leaves behind. Neither may empty the file.
    for (const q of ['&exclude=', '&exclude=,,']) {
      const res = await (await app())(`/admin/audit/export.csv?${todayRange()}${q}`, { headers: hdr });
      expect(res.status, q).toBe(200);
      expect(parseCsv(await res.text()).slice(2), q).toHaveLength(2);
      expect(res.headers.get('x-excluded-count'), q).toBe('0');
    }

    // A trailing comma is a typo, not a second code to filter on.
    const trailing = await (await app())(
      `/admin/audit/export.csv?${todayRange()}&exclude=${AuditAction.ProviderCall},`,
      { headers: hdr },
    );
    expect(parseCsv(await trailing.text()).slice(2)).toHaveLength(1);
    expect(trailing.headers.get('x-excluded-count')).toBe('1');
  });
});

describe('GET /admin/audit/export.csv — gating', () => {
  test('the export needs audit:export, not merely audit:view', async () => {
    await seedRole('r-view-only', 'audit_view_only', ['audit:view']);
    const hdr = { authorization: `Bearer ${await tokenFor('audit_view_only')}` };
    const res = await (await app())(`/admin/audit/export.csv?${todayRange()}`, { headers: hdr });
    expect(res.status).toBe(403);

    // Same caller, same route, without the export point. Without this the
    // assertion above would also hold for a caller refused by everything.
    const list = await (await app())(`/admin/audit?${todayRange()}`, { headers: hdr });
    expect(list.status).toBe(200);
  });

  test('a role holding only audit:export can export', async () => {
    // The only permission case that can see the mount order. A blanket
    // `use('/admin/audit/*', requirePermission(AuditView))` registered ABOVE
    // the export route gates it with the wrong point and refuses this
    // caller — while every other test in this file stays green, because their
    // only non-super_admin caller holds audit:view and so satisfies both
    // orderings. Verified: mounting that blanket middleware turns exactly
    // this test red and nothing else.
    //
    // It pins the intended semantics rather than an accident of ordering:
    // bulk extraction is its own permission and does not imply being able to
    // read the table on screen.
    await seedRole('r-export-only', 'audit_export_only', ['audit:export']);
    const hdr = { authorization: `Bearer ${await tokenFor('audit_export_only')}` };
    expect((await (await app())(`/admin/audit/export.csv?${todayRange()}`, { headers: hdr })).status).toBe(200);
    expect((await (await app())(`/admin/audit?${todayRange()}`, { headers: hdr })).status).toBe(403);
  });

  test('a role with neither audit point is refused on both', async () => {
    const hdr = { authorization: `Bearer ${await tokenFor('dev')}` };
    expect((await (await app())(`/admin/audit/export.csv?${todayRange()}`, { headers: hdr })).status).toBe(403);
    expect((await (await app())(`/admin/audit?${todayRange()}`, { headers: hdr })).status).toBe(403);
  });

  test('an unauthenticated caller gets 401', async () => {
    expect((await (await app())(`/admin/audit/export.csv?${todayRange()}`)).status).toBe(401);
  });

  test('an unrecognized or malformed range is a 400', async () => {
    const hdr = { authorization: `Bearer ${await superToken()}` };
    for (const q of ['range=nonsense', 'range=custom', `range=custom&from=${today()}`, 'range=custom&from=2026-02-30&to=2026-03-01']) {
      const res = await (await app())(`/admin/audit/export.csv?${q}`, { headers: hdr });
      expect(res.status, q).toBe(400);
      expect(await res.json()).toEqual({ error: 'invalid_range' });
    }
  });

  test('the export path is not swallowed by the list route', async () => {
    // Registration order, asserted against the source: Hono runs matching
    // middleware in the order it was added, so a `use('/admin/audit/*',
    // requirePermission(AuditView))` declared above this route would answer
    // 403 for a caller holding only audit:export, and the behavioural test
    // above would go red.
    const fs = await import('node:fs');
    const { fileURLToPath } = await import('node:url');
    const src = fs.readFileSync(fileURLToPath(new URL('../../src/routes/admin/audit.ts', import.meta.url)), 'utf8');
    const exportAt = src.indexOf("'/admin/audit/export.csv', requirePermission");
    const listAt = src.indexOf("'/admin/audit', requirePermission");
    expect(exportAt).toBeGreaterThan(-1);
    expect(exportAt).toBeLessThan(listAt);
  });
});
