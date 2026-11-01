import '../../helpers/setupEnv';

import { beforeEach, describe, expect, test, vi } from 'vitest';

vi.mock('../../../src/db/pool', async () => {
  const td = await import('../../../src/db/testDb');
  return { pool: td.testPool };
});

import { Hono } from 'hono';

import { authService } from '../../../src/auth/authService';
import { signToken } from '../../../src/auth/jwt';
import { resetSchema, runMigrations, testPool } from '../../../src/db/testDb';
import { adminAuditRoutes } from '../../../src/routes/admin/audit';
import { authRoutes } from '../../../src/routes/auth';

function buildApp(): Hono {
  const app = new Hono();
  app.route('/', authRoutes);
  app.route('/', adminAuditRoutes);
  return app;
}

interface ListBody {
  range: string;
  from: string;
  to: string;
  page: number;
  pageSize: number;
  total: number;
  items: {
    id: string;
    ts: string;
    user_id: string | null;
    user_name: string | null;
    action: string;
    action_zh: string;
    tone: string;
    target_type: string | null;
    target_id: string | null;
    payload: { result?: string; ip?: string } | null;
  }[];
  facets: {
    users: { value: string; label: string }[];
    actions: { value: string; label: string; label_en: string }[];
    target_types: { value: string; label: string; label_en: string }[];
  };
}

/** The default range is 30 days against the real clock, so seeded rows have to
 * land inside it. Every date below is derived from today() — a literal
 * '2026-10-21' here would start failing the day after the suite was written. */
function today(): string {
  return new Date().toISOString().slice(0, 10);
}

function daysAgo(n: number): string {
  return new Date(Date.now() - n * 86400000).toISOString().slice(0, 10);
}

async function event(opts: {
  orgId?: string;
  userId?: string | null;
  action: string;
  targetType?: string | null;
  targetId?: string | null;
  ts?: string;
}): Promise<void> {
  await testPool.query(
    `INSERT INTO audit_events(org_id,user_id,action,target_type,target_id,ts)
     VALUES ($1,$2,$3,$4,$5,$6)`,
    [
      opts.orgId ?? 'o1',
      opts.userId ?? null,
      opts.action,
      opts.targetType ?? null,
      opts.targetId ?? null,
      opts.ts ?? `${today()}T10:00:00Z`,
    ],
  );
}

let token: string;

beforeEach(async () => {
  await resetSchema();
  await runMigrations();
  await testPool.query(`INSERT INTO orgs(id, name) VALUES ('o1', 'Test'), ('o2', 'Other')`);
  await authService.createUser({ orgId: 'o1', username: 'a', password: 'pw12345' });
  token = await signToken({ sub: 'admin', orgId: 'o1', roles: ['super_admin'] });
});

async function listApp(a: Hono, query = ''): Promise<{ status: number; body: ListBody }> {
  const res = await a.request(`/admin/audit${query}`, {
    headers: { authorization: `Bearer ${token}` },
  });
  return { status: res.status, body: (await res.json()) as ListBody };
}

describe('routes/admin/audit', () => {
  test('GET /admin/audit?include=login merges login_events and dedups the audit_events login row', async () => {
    const a = buildApp();
    // Successful login → one audit_events row (action='login') plus one
    // login_events row (result='success').
    const ok = await a.request('/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ orgName: 'Test', username: 'a', password: 'pw12345' }),
    });
    expect(ok.status).toBe(200);
    // Failed login (wrong password) → only a login_events row (result='failed').
    const bad = await a.request('/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ orgName: 'Test', username: 'a', password: 'WRONG' }),
    });
    expect(bad.status).toBe(401);

    // `include=login` is what web/src/api/audit.ts still sends; the union is
    // now unconditional, so the flag is a no-op rather than a requirement.
    const { status, body } = await listApp(a, '?include=login');
    expect(status).toBe(200);
    const events = body.items;

    // The successful login appears exactly once — from login_events, not
    // duplicated from the plain audit_events login row (the merge drops it).
    const successRows = events.filter((e) => e.payload?.result === 'success');
    expect(successRows).toHaveLength(1);
    // The failed login appears once with the richer login_events payload.
    const failedRows = events.filter((e) => e.payload?.result === 'failed');
    expect(failedRows).toHaveLength(1);
    expect(failedRows[0]!.action).toBe('login');
    expect(failedRows[0]!.target_type).toBe('login');
    // Two logins in → two merged rows (3 would mean the dedup failed), and the
    // count agrees with the list: total is computed over the merged base, not
    // over audit_events alone.
    expect(events).toHaveLength(2);
    expect(body.total).toBe(2);
    // Sorted by ts DESC, id DESC.
    const ts = events.map((e) => new Date(e.ts).getTime());
    for (let i = 1; i < ts.length; i++) {
      expect(ts[i - 1]!).toBeGreaterThanOrEqual(ts[i]!);
    }
  });

  test('the response carries names, labels and facets in one round trip', async () => {
    const a = buildApp();
    await authService.createUser({
      orgId: 'o1',
      username: 'zhangwei',
      password: 'pw12345',
      displayName: '张伟',
    });
    const zhang = await testPool.query<{ id: string }>(
      `SELECT id FROM users WHERE org_id='o1' AND username='zhangwei'`,
    );
    await event({ userId: zhang.rows[0]!.id, action: 'user_disable', targetType: 'user', targetId: 'u-x' });
    // An unregistered code, written by any authenticated client via POST /audit.
    await event({ action: 'client_invented_action' });

    const { body } = await listApp(a);
    const named = body.items.find((i) => i.action === 'user_disable')!;
    expect(named.user_name).toBe('张伟');
    expect(named.user_id).toBe(zhang.rows[0]!.id);
    expect(named.user_name).not.toBe(named.user_id);
    expect(named.action_zh).toBe('停用用户');

    const invented = body.items.find((i) => i.action === 'client_invented_action')!;
    expect(invented.action_zh).toBe('client_invented_action');
    // Anonymous: no user at all, rendered as an em dash by the UI.
    expect(invented.user_id).toBeNull();
    expect(invented.user_name).toBeNull();

    expect(body.facets.users.map((u) => u.value)).toEqual([zhang.rows[0]!.id]);
    expect(body.facets.users[0]!.label).toBe('张伟');
    expect(body.facets.actions.map((x) => x.value).sort()).toEqual([
      'client_invented_action',
      'user_disable',
    ]);
    expect(body.facets.target_types.map((x) => x.value)).toEqual(['user']);
    expect(body.facets.actions.every((x) => typeof x.label === 'string' && x.label.length > 0)).toBe(true);
    expect(body.facets.target_types.every((x) => typeof x.label === 'string' && x.label.length > 0)).toBe(true);
  });

  test('?orgId= is ignored and another org is never visible', async () => {
    const a = buildApp();
    await event({ action: 'user_disable', targetType: 'user', targetId: 'mine' });
    await event({ orgId: 'o2', action: 'dept_create', targetType: 'dept', targetId: 'theirs' });
    await testPool.query(
      `INSERT INTO login_events(id,org_id,user_id,result,ts)
       VALUES ('l-other','o2',NULL,'failed',$1)`,
      [`${today()}T10:00:00Z`],
    );

    const plain = await listApp(a);
    const spoofed = await listApp(a, '?orgId=o2');
    // Editing the URL must not change a single byte of the answer.
    expect(spoofed.body.total).toBe(plain.body.total);
    expect(spoofed.body.items.map((i) => i.id).sort()).toEqual(plain.body.items.map((i) => i.id).sort());

    expect(plain.body.total).toBe(1);
    expect(plain.body.items.every((i) => i.target_id !== 'theirs')).toBe(true);
    expect(plain.body.facets.actions.map((x) => x.value)).toEqual(['user_disable']);
    expect(plain.body.facets.target_types.map((x) => x.value)).toEqual(['user']);
  });

  test('a custom range narrows the window', async () => {
    const a = buildApp();
    await event({ action: 'user_disable', targetType: 'user', targetId: 'recent' });
    await event({ action: 'dept_create', targetType: 'dept', targetId: 'old', ts: `${daysAgo(20)}T10:00:00Z` });

    const wide = await listApp(a, '?range=30d');
    expect(wide.body.total).toBe(2);

    const narrow = await listApp(a, `?range=custom&from=${today()}&to=${today()}`);
    expect(narrow.body.range).toBe('custom');
    expect(narrow.body.total).toBe(1);
    expect(narrow.body.items[0]!.target_id).toBe('recent');
    // The response states the window it actually filtered on.
    expect(new Date(narrow.body.from).toISOString().slice(0, 10)).toBe(today());
  });

  test('a malformed range is a 400, not a 500', async () => {
    const a = buildApp();
    for (const q of [
      '?range=nonsense',
      '?range=custom',
      `?range=custom&from=${today()}`,
      '?range=custom&from=2026-02-30&to=2026-03-01',
      `?range=custom&from=${today()}&to=${daysAgo(5)}`,
    ]) {
      const res = await a.request(`/admin/audit${q}`, {
        headers: { authorization: `Bearer ${token}` },
      });
      expect(res.status, q).toBe(400);
      expect(await res.json()).toEqual({ error: 'invalid_range' });
    }
  });

  test('paging defaults to 15 and clamps nonsense', async () => {
    const a = buildApp();
    await event({ action: 'user_disable', targetType: 'user' });

    const def = await listApp(a);
    expect(def.body.page).toBe(1);
    expect(def.body.pageSize).toBe(15);

    const page = await listApp(a, '?page=1&pageSize=0');
    // 0 falls back to the default rather than asking for an empty page.
    expect(page.body.pageSize).toBe(15);

    const clamped = await listApp(a, '?pageSize=99999');
    expect(clamped.body.pageSize).toBe(200);

    const noAuth = await a.request('/admin/audit');
    expect(noAuth.status).toBe(401);
  });

  test('the export path is served, and the legacy ?format=csv is gone', async () => {
    const a = buildApp();
    await event({ action: 'user_disable', targetType: 'user', targetId: 'u-x' });
    const hdr = { authorization: `Bearer ${token}` };

    // Task 11 mounted GET /admin/audit/export.csv behind audit:export. The
    // export's own contract (columns, escaping, permission probe) lives in
    // tests/analytics/auditExport.test.ts; this only pins that the path is
    // claimed by its own handler rather than swallowed by the list.
    const res = await a.request('/admin/audit/export.csv', { headers: hdr });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('text/csv; charset=utf-8');
    expect(await res.text()).toContain('停用用户');

    // The legacy spelling is removed. `/admin/audit` now ignores `format`
    // entirely and answers with the ordinary JSON list — which is what
    // web/src/api/audit.ts's exportCsv() still calls until Task 13 replaces
    // it. A client still asking for CSV gets JSON, loudly enough to notice in
    // the browser's response pane, rather than a silently-wrong file.
    const legacy = await a.request('/admin/audit?format=csv', { headers: hdr });
    expect(legacy.status).toBe(200);
    expect(legacy.headers.get('content-type')).toContain('application/json');
  });
});