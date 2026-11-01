import '../helpers/setupEnv';

import { beforeEach, describe, expect, test, vi } from 'vitest';
vi.mock('../../src/db/pool', async () => {
  const td = await import('../../src/db/testDb');
  return { pool: td.testPool };
});

import { type AuditListFilters,queryAudit } from '../../src/analytics/auditQuery';
import { resetSchema, runMigrations, testPool } from '../../src/db/testDb';
import { AuditAction } from '../../src/shared/enterpriseServerConstants';

// A frozen window: these tests assert on which rows survive a range, so the
// range must not depend on when the suite happens to run.
const FROM = new Date('2026-03-01T00:00:00Z');
const TO = new Date('2026-03-08T00:00:00Z');

// u3 deliberately has NO display_name so the COALESCE(display_name, username)
// fallback is exercised for real rather than assumed.
const U_ZHANG = 'u-zhang';
const U_LI = 'u-li';
const U_NO_NAME = 'u-noname';
const OTHER_ORG_USER = 'x-other';

/** Rows seeded inside [FROM, TO) for org o1, plus the two outside it and the
 * other org's. `TIE` is shared by an audit row and a login_events row on
 * purpose — that is the tie the `id DESC` tiebreaker exists for. */
const TIE = '2026-03-05T12:00:00Z';

async function event(opts: {
  orgId?: string;
  userId?: string | null;
  action: string;
  targetType?: string | null;
  targetId?: string | null;
  payload?: unknown;
  ts: string;
}): Promise<string> {
  const r = await testPool.query<{ id: string }>(
    `INSERT INTO audit_events(org_id,user_id,action,target_type,target_id,payload,ts)
     VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id::text AS id`,
    [
      opts.orgId ?? 'o1',
      opts.userId ?? null,
      opts.action,
      opts.targetType ?? null,
      opts.targetId ?? null,
      opts.payload === undefined ? null : JSON.stringify(opts.payload),
      opts.ts,
    ],
  );
  return r.rows[0]!.id;
}

async function login(opts: {
  orgId?: string;
  userId?: string | null;
  result: 'success' | 'failed';
  ts: string;
}): Promise<string> {
  const id = crypto.randomUUID();
  await testPool.query(
    `INSERT INTO login_events(id,org_id,user_id,ip,device,result,ts)
     VALUES ($1,$2,$3,'10.0.0.9','chrome',$4,$5)`,
    [id, opts.orgId ?? 'o1', opts.userId ?? null, opts.result, opts.ts],
  );
  return id;
}

beforeEach(async () => {
  await resetSchema();
  await runMigrations();
  await testPool.query(`INSERT INTO orgs(id,name) VALUES ('o1','Org One'),('o2','Org Two')`);
  await testPool.query(
    `INSERT INTO users(id,org_id,username,password_hash,display_name) VALUES
       ($1,'o1','zhangwei','x','张伟'),
       ($2,'o1','lina','x','李娜'),
       ($3,'o1','wangwu','x',NULL),
       ($4,'o2','otherguy','x','他组织的人')`,
    [U_ZHANG, U_LI, U_NO_NAME, OTHER_ORG_USER],
  );

  // --- in range, org o1 -----------------------------------------------------
  await event({ userId: U_ZHANG, action: AuditAction.UserDisable, targetType: 'user', targetId: 'u-victim', ts: '2026-03-01T10:00:00Z' });
  await event({ userId: U_LI, action: AuditAction.DeptCreate, targetType: 'dept', targetId: 'd-1', ts: '2026-03-02T10:00:00Z' });
  // Anonymous: an unauthenticated sign-in failure carries no user at all.
  await event({ userId: null, action: AuditAction.LoginFailed, ts: '2026-03-03T10:00:00Z' });
  // Neither code is registered — `POST /audit` lets any client self-report one.
  await event({ userId: U_ZHANG, action: 'client_invented_action', targetType: 'client_invented_type', targetId: 'zz-1', ts: '2026-03-04T10:00:00Z' });
  // The audit_events half of a SUCCESSFUL login. Its login_events twin sits at
  // the same timestamp (TIE), so the dedup and the ordering tiebreaker are
  // exercised by the same pair of rows.
  await event({ userId: U_ZHANG, action: AuditAction.Login, ts: TIE });
  await event({ userId: U_NO_NAME, action: AuditAction.DeptUpdate, targetType: 'dept', targetId: 'd-1', ts: TIE });

  // --- outside the range ----------------------------------------------------
  await event({ userId: U_ZHANG, action: AuditAction.UserDisable, targetType: 'user', targetId: 'u-victim', ts: '2026-02-28T10:00:00Z' });
  // Exactly `to`: the window is half-open, so this one is excluded.
  await event({ userId: U_ZHANG, action: AuditAction.UserDisable, targetType: 'user', targetId: 'u-victim', ts: TO.toISOString() });

  // --- another org ----------------------------------------------------------
  await event({ orgId: 'o2', userId: OTHER_ORG_USER, action: AuditAction.UserDisable, targetType: 'user', targetId: 'u-victim', ts: '2026-03-02T11:00:00Z' });
  await login({ orgId: 'o2', userId: OTHER_ORG_USER, result: 'failed', ts: '2026-03-02T11:30:00Z' });

  // --- sign-ins: the login_events half of the union -------------------------
  // Same timestamp as the audit_events login row above: a duplicate AND an
  // ordering tie, in one pair of rows.
  await login({ userId: U_ZHANG, result: 'success', ts: TIE });
  // A failed attempt has NO audit_events row at all, and no user (the username
  // was not one this org knows).
  await login({ userId: null, result: 'failed', ts: '2026-03-06T09:00:00Z' });
});

function list(over: Partial<Parameters<typeof queryAudit>[0]> = {}) {
  return queryAudit({
    orgId: 'o1',
    from: FROM,
    to: TO,
    filters: {},
    includeLogin: true,
    page: 1,
    pageSize: 50,
    ...over,
  });
}

function filters(over: AuditListFilters): Parameters<typeof queryAudit>[0]['filters'] {
  return over;
}

describe('queryAudit — the actor column shows a name', () => {
  test('user_name is a display name, never a UUID', async () => {
    const r = await list();
    const zhang = r.items.find((i) => i.action === AuditAction.UserDisable && i.ts === '2026-03-01T10:00:00.000Z');
    expect(zhang).toBeDefined();
    expect(zhang!.user_id).toBe(U_ZHANG);
    expect(zhang!.user_name).toBe('张伟');
    expect(zhang!.user_name).not.toBe(zhang!.user_id);

    // COALESCE(display_name, username): this member never set a display name.
    const wang = r.items.find((i) => i.action === AuditAction.DeptUpdate);
    expect(wang!.user_name).toBe('wangwu');
  });

  test('an anonymous event has null user_name', async () => {
    const r = await list();
    const anonymous = r.items.find((i) => i.action === AuditAction.LoginFailed);
    expect(anonymous).toBeDefined();
    expect(anonymous!.user_id).toBeNull();
    expect(anonymous!.user_name).toBeNull();
    // "No object" is null, not the string 「null」.
    expect(anonymous!.target_type).toBeNull();
    expect(anonymous!.target_type_zh).toBeNull();
  });

  test('a registered action carries its zh/en label and tone', async () => {
    const r = await list();
    const disable = r.items.find((i) => i.action === AuditAction.UserDisable && i.ts === '2026-03-01T10:00:00.000Z');
    expect(disable!.action_zh).toBe('停用用户');
    expect(disable!.action_en).toBe('Disabled user');
    expect(disable!.tone).toBe('danger');
    expect(disable!.target_type).toBe('user');
    expect(disable!.target_type_zh).toBe('用户');
  });

  test('an action with no registered label falls back to its raw code', async () => {
    const r = await list();
    const invented = r.items.find((i) => i.action === 'client_invented_action');
    expect(invented).toBeDefined();
    expect(invented!.action_zh).toBe('client_invented_action');
    expect(invented!.action_en).toBe('client_invented_action');
    expect(invented!.tone).toBe('normal');
    // Same rule for the object column.
    expect(invented!.target_type_zh).toBe('client_invented_type');
  });
});

describe('queryAudit — filters', () => {
  test('targetType and targetId filters stack', async () => {
    const all = await list();
    const dept = await list({ filters: filters({ targetType: 'dept' }) });
    expect(dept.total).toBe(2);
    expect(dept.items.every((i) => i.target_type === 'dept')).toBe(true);
    expect(dept.total).toBeLessThan(all.total);

    // The Departments page's question: targetType + targetId together.
    const one = await list({ filters: filters({ targetType: 'dept', targetId: 'd-1' }) });
    expect(one.total).toBe(2);
    expect(one.items.every((i) => i.target_type === 'dept' && i.target_id === 'd-1')).toBe(true);
    expect(one.items.map((i) => i.action).sort()).toEqual(['dept_create', 'dept_update']);
  });

  test('userId, action and targetId all narrow the same base', async () => {
    const byUser = await list({ filters: filters({ userId: U_LI }) });
    expect(byUser.total).toBe(1);
    expect(byUser.items[0]!.action).toBe(AuditAction.DeptCreate);

    const byAction = await list({ filters: filters({ action: AuditAction.Login }) });
    // Only the login_events rows survive — two of them, one per attempt — and
    // the audit_events login row that duplicated the success is not a third.
    expect(byAction.total).toBe(2);
    expect(byAction.items.every((i) => i.target_type === 'login')).toBe(true);
    expect(
      byAction.items.map((i) => (i.payload as { result?: string } | null)?.result).sort(),
    ).toEqual(['failed', 'success']);

    const byTarget = await list({ filters: filters({ targetId: 'u-victim' }) });
    expect(byTarget.total).toBe(1);
    expect(byTarget.items[0]!.user_id).toBe(U_ZHANG);
  });

  test('the range is half-open: [from, to)', async () => {
    const r = await list();
    expect(r.items.some((i) => i.ts === FROM.toISOString())).toBe(false);
    // Seeded exactly at `to`, so it must be outside.
    const atTo = r.items.filter((i) => new Date(i.ts).getTime() === TO.getTime());
    expect(atTo).toHaveLength(0);
    // Seeded before `from`, so it must be outside too.
    const before = r.items.filter((i) => i.ts === '2026-02-28T10:00:00.000Z');
    expect(before).toHaveLength(0);
  });

  test('another org is never visible, in items, total or facets', async () => {
    const r = await list();
    expect(r.total).toBe(7);
    expect(r.items.every((i) => i.user_name !== '他组织的人')).toBe(true);
    expect(r.facets.users.map((u) => u.value)).not.toContain(OTHER_ORG_USER);
    // The other org's two sign-in rows are not in the base either.
    expect(r.total).toBe(7);
  });
});

/**
 * Model calls — the rows `exclude` exists for.
 *
 * Seeded per test rather than in `beforeEach` so the shared fixture, and every
 * assertion pinned to its counts, stay exactly as they were. `model` is the
 * `target_type` the proxy actually writes (see `providerProxy.ts`), not an
 * invented one.
 */
async function seedProviderCalls(n: number, userId: string = U_ZHANG): Promise<void> {
  for (let i = 0; i < n; i++) {
    await event({
      userId,
      action: AuditAction.ProviderCall,
      targetType: 'model',
      targetId: `m-${i}`,
      ts: '2026-03-04T12:00:00Z',
    });
  }
}

describe('queryAudit — exclude', () => {
  test('an excluded action leaves the items AND the total', async () => {
    await seedProviderCalls(3);
    const all = await list();
    expect(all.total).toBe(10);
    expect(all.items.filter((i) => i.action === AuditAction.ProviderCall)).toHaveLength(3);

    const hidden = await list({ filters: filters({ exclude: [AuditAction.ProviderCall] }) });
    expect(hidden.total).toBe(7);
    expect(hidden.items).toHaveLength(7);
    expect(hidden.items.some((i) => i.action === AuditAction.ProviderCall)).toBe(false);
    // The rows are gone, not relabelled or paged around: what survives is
    // exactly what survived without the exclusion.
    expect(hidden.items.map((i) => i.id).sort()).toEqual(
      all.items.filter((i) => i.action !== AuditAction.ProviderCall).map((i) => i.id).sort(),
    );
    // …and the facets are untouched, unlike `total`.
    expect(hidden.facets.actions).toHaveLength(7);
  });

  test('an excluded action is still offered in the actions facet', async () => {
    // The dropdown is the only route back. If the exclusion reached the facets
    // the filter would be a one-way door: the code would be gone from the list
    // exactly when the user went looking for it.
    await seedProviderCalls(3);
    const hidden = await list({ filters: filters({ exclude: [AuditAction.ProviderCall] }) });
    const all = await list();

    expect(hidden.facets.actions.map((a) => a.value)).toContain(AuditAction.ProviderCall);
    expect(hidden.facets.actions.map((a) => a.value).sort()).toEqual(
      all.facets.actions.map((a) => a.value).sort(),
    );
    // It is still labelled, not offered as a bare code.
    expect(hidden.facets.actions.find((a) => a.value === AuditAction.ProviderCall)!.label).toBe('调用模型服务商');
  });

  test('excluded counts what the request matched and did not return', async () => {
    await seedProviderCalls(3);
    const all = await list();
    const hidden = await list({ filters: filters({ exclude: [AuditAction.ProviderCall] }) });

    expect(hidden.excluded).toBe(3);
    expect(hidden.total + hidden.excluded).toBe(all.total);
    // Nothing excluded: a plain 0, so a caller can render "N hidden"
    // unconditionally and get silence when there is nothing to disclose.
    expect(all.excluded).toBe(0);
  });

  test('exclude stacks with the other filters', async () => {
    await seedProviderCalls(3, U_LI);
    // 李娜's window holds her one dept_create row and the three model calls.
    const hidden = await list({ filters: filters({ userId: U_LI, exclude: [AuditAction.ProviderCall] }) });
    expect(hidden.total).toBe(1);
    expect(hidden.items[0]!.action).toBe(AuditAction.DeptCreate);
    // The hidden count is scoped to the filters in force, not global: these
    // three calls belong to 李娜, and none of 张三's are being counted.
    expect(hidden.excluded).toBe(3);

    const other = await list({ filters: filters({ userId: U_ZHANG, exclude: [AuditAction.ProviderCall] }) });
    expect(other.excluded).toBe(0);
  });

  test('an empty exclusion list is the unfiltered request', async () => {
    await seedProviderCalls(3);
    const all = await list();
    // `?exclude=` and a stray entry both arrive here: an empty element must
    // never become a predicate that matches nothing and empties the table.
    for (const exclude of [[], [''], ['   ']]) {
      const r = await list({ filters: filters({ exclude }) });
      expect(r.total).toBe(all.total);
      expect(r.excluded).toBe(0);
    }
  });

  test('excluding the action that is selected empties the table', async () => {
    // `action=provider_call&exclude=provider_call` is a contradiction, and the
    // honest answer to it is nothing — not a quiet fallback to the rows the
    // include-filter would have shown on its own.
    await seedProviderCalls(3);
    const r = await list({
      filters: filters({ action: AuditAction.ProviderCall, exclude: [AuditAction.ProviderCall] }),
    });
    expect(r.total).toBe(0);
    expect(r.items).toEqual([]);
    expect(r.excluded).toBe(3);
  });
});

describe('queryAudit — the login_events union', () => {
  test('a successful login appears once, from login_events', async () => {
    const r = await list();
    const logins = r.items.filter((i) => i.action === AuditAction.Login);
    // Two sign-in rows exist (one success, one failure); the audit_events login
    // row that duplicated the success is not a third.
    expect(logins).toHaveLength(2);
    const success = logins.filter((i) => (i.payload as { result?: string } | null)?.result === 'success');
    expect(success).toHaveLength(1);
    // The surviving row keeps the richer login_events payload.
    expect((success[0]!.payload as { ip: string }).ip).toBe('10.0.0.9');
    expect(success[0]!.target_type).toBe('login');
  });

  test('includeLogin off reads audit_events alone, login rows included', async () => {
    const r = await list({ includeLogin: false });
    // The six in-range audit rows, the audit_events login row among them.
    expect(r.total).toBe(6);
    const logins = r.items.filter((i) => i.action === AuditAction.Login);
    expect(logins).toHaveLength(1);
    // The failed sign-in has no audit_events row, so it disappears entirely —
    // which is exactly why the page passes includeLogin: true.
    expect(logins.some((i) => (i.payload as { result?: string } | null)?.result === 'failed')).toBe(false);
  });

  test('total counts both sources when includeLogin is on', async () => {
    const withLogin = await list();
    const withoutLogin = await list({ includeLogin: false });

    // 6 audit rows - 1 dropped login row + 2 login_events rows.
    expect(withoutLogin.total).toBe(6);
    expect(withLogin.total).toBe(7);
    // total is the count of the MERGED base, not of audit_events alone: an
    // items array longer than `total` would be the tell.
    expect(withLogin.items).toHaveLength(7);
  });

  test('a page past the end still reports the merged total', async () => {
    const r = await list({ page: 3, pageSize: 3 });
    expect(r.items).toHaveLength(1);
    expect(r.total).toBe(7);
    expect(r.page).toBe(3);
    expect(r.pageSize).toBe(3);
  });
});

describe('queryAudit — facets', () => {
  test('facets contain only values present in range and never nulls', async () => {
    const r = await list();

    const actions = r.facets.actions.map((a) => a.value);
    expect(actions).toEqual(
      expect.arrayContaining([
        AuditAction.Login,
        AuditAction.LoginFailed,
        AuditAction.UserDisable,
        AuditAction.DeptCreate,
        AuditAction.DeptUpdate,
        'client_invented_action',
      ]),
    );
    // Everything outside the window is absent, and so is any null.
    expect(actions).toHaveLength(6);
    expect(actions.every((a) => typeof a === 'string' && a.length > 0)).toBe(true);
    expect(r.facets.actions.find((a) => a.value === 'client_invented_action')!.label).toBe(
      'client_invented_action',
    );

    const targetTypes = r.facets.target_types.map((t) => t.value);
    expect(targetTypes.sort()).toEqual(['client_invented_type', 'dept', 'login', 'user']);
    expect(targetTypes.every((t) => typeof t === 'string' && t.length > 0)).toBe(true);
    // The anonymous row has target_type NULL, which is never an option.
    expect(targetTypes).not.toContain(null);

    const users = r.facets.users;
    expect(users.map((u) => u.value).sort()).toEqual([U_NO_NAME, U_LI, U_ZHANG].sort());
    expect(users.every((u) => typeof u.label === 'string' && u.label.length > 0)).toBe(true);
    expect(users.map((u) => u.label).sort()).toEqual(['wangwu', '张伟', '李娜'].sort());
  });

  test('facets are not narrowed by the active filters', async () => {
    const unfiltered = await list();
    const filtered = await list({ filters: filters({ action: AuditAction.DeptCreate }) });
    // Narrowing the table to one action must not empty the action dropdown,
    // or the filter could never be cleared from the UI.
    expect(filtered.total).toBe(1);
    expect(filtered.facets.actions.map((a) => a.value).sort()).toEqual(
      unfiltered.facets.actions.map((a) => a.value).sort(),
    );
    expect(filtered.facets.users.map((u) => u.value).sort()).toEqual(
      unfiltered.facets.users.map((u) => u.value).sort(),
    );
  });

  test('a narrower range narrows the facets with it', async () => {
    // Only the anonymous login_failed row falls in this window: it has no
    // object and no user, so both of those facet lists come back empty rather
    // than holding a null.
    const narrow = await list({
      from: new Date('2026-03-03T00:00:00Z'),
      to: new Date('2026-03-04T00:00:00Z'),
    });
    expect(narrow.total).toBe(1);
    expect(narrow.facets.actions.map((a) => a.value)).toEqual([AuditAction.LoginFailed]);
    expect(narrow.facets.target_types).toEqual([]);
    expect(narrow.facets.users).toEqual([]);
  });
});

describe('queryAudit — deterministic paging', () => {
  test('paging is stable when two events share a timestamp', async () => {
    // The audit_events dept_update row and the login_events success row are
    // both stamped TIE. `ORDER BY ts DESC` alone leaves their relative order
    // undefined, so the same row could answer page 2 on one request and page
    // 3 on the next — the same event on two pages, another on none.
    const all = await list({ pageSize: 50 });
    const [first, second] = [all.items[1]!, all.items[2]!];
    expect(new Date(first.ts).getTime()).toBe(new Date(TIE).getTime());
    expect(new Date(second.ts).getTime()).toBe(new Date(TIE).getTime());
    expect(first.id).not.toBe(second.id);

    // Walking one row at a time must reproduce the full order exactly.
    const page2 = await list({ page: 2, pageSize: 1 });
    const page2Again = await list({ page: 2, pageSize: 1 });
    const page3 = await list({ page: 3, pageSize: 1 });
    expect(page2.items[0]!.id).toBe(first.id);
    expect(page2Again.items[0]!.id).toBe(first.id);
    expect(page3.items[0]!.id).toBe(second.id);
  });

  test('walking every page yields each row exactly once', async () => {
    const pageSize = 2;
    const seen: string[] = [];
    for (let page = 1; page <= 4; page++) {
      const r = await list({ page, pageSize });
      seen.push(...r.items.map((i) => i.id));
    }
    const all = await list({ pageSize: 50 });
    expect(seen).toHaveLength(7);
    expect(new Set(seen).size).toBe(7);
    expect(seen.sort()).toEqual(all.items.map((i) => i.id).sort());
  });
});