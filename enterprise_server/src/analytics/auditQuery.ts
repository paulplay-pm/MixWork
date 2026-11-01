import { pool } from '../db/pool';
import { auditActionMeta, type AuditTone } from '../shared/auditActionMeta';
import { auditTargetTypeMeta } from '../shared/auditTargetTypeMeta';

/** Stacking filters. Every one that is present narrows the base further, so
 * `targetType=dept&targetId=<id>` is the Departments page's question ("what
 * happened to THIS department") rather than a second request. `targetId` has
 * no counterpart in the audit list UI and exists for `DeptDetail.tsx`, which
 * used to pull 200 rows and filter client-side. */
export interface AuditListFilters {
  userId?: string;
  action?: string;
  targetType?: string;
  targetId?: string;
  /** Action codes to DROP, rather than to select.
   *
   * The four above narrow by equality and all narrow in the same direction.
   * This one removes rows the page would otherwise serve, and it exists because
   * `provider_call` is written for every model request the proxy relays: since
   * the gateway streams essentially all enterprise traffic, a feed of nothing
   * but 「调用模型服务商」 buries the sign-in failures, permission changes and key
   * revocations an admin actually opens this page for. The data is not wrong —
   * only the default reading of it.
   *
   * It is a server-side drop, never a client-side one: filtering after the
   * fetch would make the CSV disagree with the table, and their agreement is
   * the invariant this module exists to keep.
   *
   * It deliberately does NOT reach the facets. `actions` is computed from
   * `base`, so an excluded code is still offered in the dropdown and can be put
   * back — narrowing the facet by the exclusion would make it a one-way door. */
  exclude?: string[];
}

/** One row of the audit feed.
 *
 * `user_name` is what a table cell renders; `user_id` survives only as the
 * filter value behind the user dropdown. `action`/`action_zh`/`action_en`/
 * `tone` are resolved here rather than in the browser so the server stays the
 * single authority on labels — and so an unregistered code (any authenticated
 * client can `POST /audit` with a code it invented) is labelled as itself
 * rather than as a blank cell. */
export interface AuditListItem {
  id: string;
  ts: string;
  user_id: string | null;
  user_name: string | null;
  action: string;
  action_zh: string;
  action_en: string;
  tone: AuditTone;
  target_type: string | null;
  target_type_zh: string | null;
  target_id: string | null;
  payload: unknown;
}

export interface AuditFacetUser {
  value: string;
  label: string;
}

export interface AuditFacetMeta {
  value: string;
  label: string;
  label_en: string;
}

/** Dropdown options, computed from the rows actually in range.
 *
 * They ride along in the list response (spec §5.3) rather than costing a
 * second round trip per open. Options are NOT narrowed by the active filters:
 * picking 「停用用户」 must not empty the action dropdown, or the filter becomes
 * a one-way door. `users` entries always carry a resolvable name — a
 * `user_id` with no `users` row produces no option at all rather than a
 * dropdown full of raw UUIDs. */
export interface AuditFacets {
  users: AuditFacetUser[];
  actions: AuditFacetMeta[];
  target_types: AuditFacetMeta[];
}

export interface AuditListResult {
  page: number;
  pageSize: number;
  total: number;
  items: AuditListItem[];
  facets: AuditFacets;
  from: Date;
  to: Date;
  /** Rows that `exclude` removed: everything matching the other filters whose
   * action is on the exclusion list. Zero when nothing is excluded, so a
   * caller can render "N hidden" unconditionally and get silence when there is
   * nothing to disclose. It is a count of data the request DID match, which is
   * what makes a quiet filter say so. */
  excluded: number;
}

export interface QueryAuditArgs {
  orgId: string;
  from: Date;
  to: Date;
  filters: AuditListFilters;
  /**
   * Union `login_events` into the feed. Off means `audit_events` alone, which
   * is what the unit tests of the SQL shape want when they are not exercising
   * the merge; on is what the admin page asks for (spec §5.3), because a
   * failed sign-in writes NO `audit_events` row and would otherwise be
   * invisible exactly when someone is looking for it.
   */
  includeLogin: boolean;
  page: number;
  pageSize: number;
}

/**
 * `base` — the merged, windowed, deduped row set every other statement reads.
 *
 * The `login_events` half is projected into the `audit_events` shape
 * (`action='login'`, `target_type='login'`, payload rebuilt from
 * ip/device/result) so every consumer downstream — filters, count, page
 * window, facets — reads one shape and cannot forget that a second source
 * exists. That is the whole reason the total cannot be computed against
 * `audit_events` alone: with the union on, `COUNT(*)` over the audit table
 * under-reports by exactly the number of sign-in attempts, and the page then
 * advertises fewer rows than it serves.
 *
 * The dedup rule: a successful login writes an `audit_events` row AND a
 * `login_events` row, so a UNION ALL would list it twice. The `audit_events`
 * login rows are dropped and `login_events` supplies every sign-in row
 * instead — including the failed ones, which have no audit row at all. The
 * surviving row keeps the richer `login_events` payload (ip / device /
 * result), which is the reason the union exists; an `audit_events` login row
 * carries a NULL payload and no ip at all. This preserves the behaviour
 * `tests/routes/admin/audit.test.ts` pins.
 *
 * The window is half-open `[from, to)` and both sources are filtered by it
 * before the union, so a sign-in can never leak in from outside the range the
 * page claims to cover.
 *
 * The two `'login'` literals mirror `AuditAction.Login` and the `login` entry
 * of `KNOWN_TARGET_TYPES`. They are inlined rather than bound because they are
 * code constants and never request input: binding them would renumber the
 * placeholders differently between the two variants of this template, and the
 * drivers reject a bind count that disagrees with the statement.
 */
function baseCte(includeLogin: boolean): string {
  const dedup = includeLogin ? `\n      AND a.action <> 'login'` : '';
  const loginBranch = includeLogin
    ? `
    UNION ALL
    SELECT l.id::text     AS id,
           l.org_id       AS org_id,
           l.user_id      AS user_id,
           'login'::text  AS action,
           'login'::text  AS target_type,
           NULL::text     AS target_id,
           jsonb_build_object('ip', l.ip, 'device', l.device, 'result', l.result) AS payload,
           l.ts           AS ts
    FROM login_events l
    WHERE l.org_id = $1 AND l.ts >= $2 AND l.ts < $3`
    : '';

  return `
  base AS (
    SELECT a.id::text     AS id,
           a.org_id       AS org_id,
           a.user_id      AS user_id,
           a.action       AS action,
           a.target_type  AS target_type,
           a.target_id    AS target_id,
           a.payload      AS payload,
           a.ts           AS ts
    FROM audit_events a
    WHERE a.org_id = $1 AND a.ts >= $2 AND a.ts < $3${dedup}${loginBranch}
  )`;
}

/**
 * The four equality filters plus the exclusion, as TWO CTEs.
 *
 * `included` is everything the request matched — base narrowed by the four
 * `=` filters. `filtered` is what the page actually serves: `included` minus
 * the excluded actions. Keeping them apart is what lets `excluded` be an
 * honest subtraction (`COUNT(included) - COUNT(filtered)`) rather than a second
 * query or a guess, and it means the count cannot drift from the rows: both
 * numbers come from the same two statements the page reads.
 *
 * A filter that was not supplied contributes no predicate at all rather than a
 * bound NULL compared against the column: `($4::text IS NULL OR action = $4)`
 * is compact but stops the planner from using `audit_events_org_ts_action`,
 * the index migration 052 added precisely so the audit list can filter action
 * alongside ts.
 *
 * `exclude` binds ONE array parameter, not one parameter per excluded code.
 * The list is caller-supplied and unbounded, and a caller passing 70,000 codes
 * would otherwise hit Postgres' 65535-parameter ceiling and turn a filter into
 * a 500. `<> ALL` rather than `NOT IN`: `NOT IN` is a three-valued trap the
 * moment one entry is NULL, silently emptying the table. `action` is NOT NULL
 * in `audit_events` and the login union supplies a literal, so no row reaching
 * this CTE can be NULL and drop out on that comparison.
 */
function filteredCte(filters: AuditListFilters, params: unknown[]): string {
  const clauses: string[] = [];
  const add = (column: string, value: string | undefined): void => {
    if (!value) return;
    params.push(value);
    clauses.push(`b.${column} = $${params.length}`);
  };
  add('user_id', filters.userId);
  add('action', filters.action);
  add('target_type', filters.targetType);
  add('target_id', filters.targetId);

  const codes = (filters.exclude ?? []).filter((code) => code.length > 0);
  let excludeClause = '';
  if (codes.length > 0) {
    params.push(codes);
    excludeClause = `WHERE i.action <> ALL($${params.length}::text[])`;
  }

  return `
  included AS (
    SELECT b.*
    FROM base b
    ${clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : ''}
  ),
  filtered AS (
    SELECT i.*
    FROM included i
    ${excludeClause}
  )`;
}

/**
 * `id DESC` is the tiebreaker after `ts DESC` and it is load-bearing.
 *
 * `ts` is not unique: a bulk operation writes many rows in one transaction and
 * therefore one timestamp. `ORDER BY ts DESC` alone leaves their relative
 * order undefined, so two identical requests can return the same event on page
 * 1 and page 2 — a row appears twice and another never appears at all. `id` is
 * the primary key of the underlying row, which makes the order total.
 *
 * `audit_events.id` is a bigint and `login_events.id` a uuid, so the cast to
 * text in `baseCte` is what lets one key sort both halves; the two id spaces
 * do not collide, so the merged key is still unique.
 *
 * `LEFT JOIN users` resolves the display name for the actor column.
 * `COALESCE(display_name, username)` is the fallback (a member may have no
 * display name set), and the join is org-scoped so a stray cross-org
 * `user_id` resolves to nothing rather than to another org's employee. An
 * anonymous event — `user_id IS NULL`, e.g. an unauthenticated SSO sign-in
 * failure — has no join partner, so `user_name` comes back null and the UI
 * renders an em dash instead of a blank cell that reads as a rendering bug.
 */
function pageQuery(base: string, filtered: string, limitIdx: number, offsetIdx: number): string {
  return `
  WITH ${base},
  ${filtered}
  SELECT f.id,
         f.ts,
         f.user_id,
         COALESCE(u.display_name, u.username) AS user_name,
         f.action,
         f.target_type,
         f.target_id,
         f.payload
  FROM filtered f
  LEFT JOIN users u ON u.id = f.user_id AND u.org_id = $1
  ORDER BY f.ts DESC, f.id DESC
  LIMIT $${limitIdx} OFFSET $${offsetIdx}
`;
}

/**
 * `total`, `excluded` and the three facet lists, in one statement that always
 * returns exactly one row.
 *
 * Both read the CTE base, never `audit_events`:
 *  - `total` reads `filtered`, so it counts what the page can actually serve.
 *    Computed against the audit table alone it under-reports the moment the
 *    `login_events` union is on.
 *  - `excluded` is `COUNT(included) - COUNT(filtered)`: the rows the request
 *    matched and the page is not showing. Both halves read the same two CTEs,
 *    so the number cannot drift from the rows it describes, and it is a plain
 *    0 when nothing is excluded — no conditional needed.
 *  - the facets read `base` WITHOUT the filters — and without the exclusion —
 *    because a dropdown that empties as soon as you use it cannot be used to
 *    change the filter. That is what keeps an excluded action re-enableable.
 *
 * Facet values are de-duplicated in SQL and labelled in JS: the SQL side
 * cannot know a client's invented action code, and `auditActionMeta` /
 * `auditTargetTypeMeta` both fall back to the raw value for anything they do
 * not recognise, so the dropdown can never offer a nameless code.
 *
 * `users` drops any `user_id` with no `users` row rather than offering the id
 * itself as the label — the acceptance rule is that a UUID never reaches a
 * cell.
 *
 * The facets come back as jsonb arrays so this is a single row; the drivers
 * disagree about `bigint` (`pg` hands back a string, pglite a number), which
 * is why `total` and `excluded` both go through `Number()` below.
 */
function aggregatesQuery(base: string, filtered: string): string {
  return `
  WITH ${base},
  ${filtered}
  SELECT
    (SELECT COUNT(*)::bigint FROM filtered) AS total,
    ((SELECT COUNT(*)::bigint FROM included) - (SELECT COUNT(*)::bigint FROM filtered))::bigint AS excluded,
    (SELECT COALESCE(jsonb_agg(jsonb_build_object('value', f.value, 'label', f.label)
                               ORDER BY f.label), '[]'::jsonb)
       FROM (SELECT DISTINCT b.user_id AS value,
                    COALESCE(u.display_name, u.username) AS label
             FROM base b
             JOIN users u ON u.id = b.user_id AND u.org_id = $1
             WHERE b.user_id IS NOT NULL) f
     ) AS users_facet,
    (SELECT COALESCE(jsonb_agg(jsonb_build_object('value', f.value) ORDER BY f.value), '[]'::jsonb)
       FROM (SELECT DISTINCT action AS value FROM base WHERE action IS NOT NULL) f
    ) AS actions_facet,
    (SELECT COALESCE(jsonb_agg(jsonb_build_object('value', f.value) ORDER BY f.value), '[]'::jsonb)
       FROM (SELECT DISTINCT target_type AS value FROM base WHERE target_type IS NOT NULL) f
    ) AS target_types_facet
`;
}

/** `ts` is `NOT NULL` in both source tables, so there is no null case to
 * render — the string arm exists only because the two drivers disagree about
 * the JS type they hand back for `timestamptz`. */
function toIso(value: Date | string): string {
  return (value instanceof Date ? value : new Date(value)).toISOString();
}

function mapRows(
  rows: {
    id: string;
    ts: Date | string;
    user_id: string | null;
    user_name: string | null;
    action: string;
    target_type: string | null;
    target_id: string | null;
    payload: unknown;
  }[],
): AuditListItem[] {
  return rows.map((row) => {
    const action = auditActionMeta(row.action);
    // null target_type means "no object", and null is the signal the UI
    // renders as an em dash; the meta accessor would otherwise turn it into a
    // label reading 「null」.
    const target = auditTargetTypeMeta(row.target_type);
    return {
      id: row.id,
      ts: toIso(row.ts),
      user_id: row.user_id,
      user_name: row.user_name,
      action: row.action,
      action_zh: action.zh,
      action_en: action.en,
      tone: action.tone,
      target_type: row.target_type,
      target_type_zh: target ? target.zh : null,
      target_id: row.target_id,
      payload: row.payload,
    };
  });
}

export async function queryAudit(args: QueryAuditArgs): Promise<AuditListResult> {
  const pageSize = Math.max(1, Math.floor(args.pageSize));
  const page = Math.max(1, Math.floor(args.page));
  const offset = (page - 1) * pageSize;

  const base = baseCte(args.includeLogin);
  const shared: unknown[] = [args.orgId, args.from, args.to];
  const filtered = filteredCte(args.filters, shared);

  const limitIdx = shared.length + 1;
  const offsetIdx = limitIdx + 1;

  const [pageResult, aggResult] = await Promise.all([
    pool.query<{
      id: string;
      ts: Date | string;
      user_id: string | null;
      user_name: string | null;
      action: string;
      target_type: string | null;
      target_id: string | null;
      payload: unknown;
    }>(pageQuery(base, filtered, limitIdx, offsetIdx), [...shared, pageSize, offset]),
    pool.query<{
      total: string | number;
      excluded: string | number;
      users_facet: { value: string; label: string | null }[];
      actions_facet: { value: string }[];
      target_types_facet: { value: string }[];
    }>(aggregatesQuery(base, filtered), [...shared]),
  ]);

  const agg = aggResult.rows[0];
  const users: AuditFacetUser[] = (agg?.users_facet ?? [])
    // A row whose name did not resolve is dropped rather than shown as its id:
    // the dropdown is a place a UUID must never appear.
    .filter((u): u is { value: string; label: string } => typeof u.label === 'string' && u.label.length > 0)
    .map((u) => ({ value: u.value, label: u.label }));

  const actions: AuditFacetMeta[] = (agg?.actions_facet ?? []).map((a) => {
    const meta = auditActionMeta(a.value);
    return { value: a.value, label: meta.zh, label_en: meta.en };
  });

  const targetTypes: AuditFacetMeta[] = (agg?.target_types_facet ?? []).map((t) => {
    // Non-null by construction (the CTE filters NULL out), so the accessor
    // cannot return null here; the fallback keeps the type honest without an
    // extra branch that could only ever be dead.
    const meta = auditTargetTypeMeta(t.value) ?? { value: t.value, zh: t.value, en: t.value };
    return { value: t.value, label: meta.zh, label_en: meta.en };
  });

  return {
    page,
    pageSize,
    total: Number(agg?.total ?? 0),
    excluded: Number(agg?.excluded ?? 0),
    items: mapRows(pageResult.rows),
    facets: { users, actions, target_types: targetTypes },
    from: args.from,
    to: args.to,
  };
}