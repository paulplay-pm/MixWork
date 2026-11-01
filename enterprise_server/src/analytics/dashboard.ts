import { pool } from '../db/pool';
import { AuditAction } from '../shared/enterpriseServerConstants';
import { queryAudit } from './auditQuery';
import { resolvePreviousUsageRange, resolveUsageRange, UsageRange } from './range';

/**
 * The dashboard's aggregation queries.
 *
 * Everything here answers ONE board-sized question and nothing more: what is
 * this org's shape right now. Two rules run through the whole module.
 *
 *  1. **The dashboard reads; it never writes.** Service health in particular is
 *     read-only — the `last_test_*` columns are written solely by an admin
 *     clicking "test connection" on a config page. A dashboard that triggered its
 *     own probes would fire real requests at every upstream on a timer.
 *  2. **A caller who lacks a permission point must not be able to infer the
 *     number behind it.** Section trimming happens in the route, but the
 *     queries take the flags they need so a trimmed section is never computed
 *     and its absence cannot leak through a side channel (a `checkedAt` that
 *     still moves for rows you may not see is exactly such a channel).
 *
 * Every numeric column is coerced with `Number()` at the boundary: `pg` returns
 * `bigint` as a string and pglite returns it as a number, and a dashboard that
 * renders `1,234` on one driver and `1234` on the other is a bug report waiting
 * to happen.
 */

export type HealthStatus = 'ok' | 'warn' | 'err' | 'unknown';
export type HealthKind = 'model' | 'mcp';

export interface UserCounts {
  total: number;
  enabled: number;
  disabled: number;
}

export interface AgentCounts {
  enabled: number;
  total: number;
}

export interface McpCounts {
  enabled: number;
  total: number;
  /** Enabled connectors whose last test failed. Counted over ALL of them, not
   *  over the six rows the health list shows — a card that says "2 异常" while
   *  the list can only ever display one of them is worse than no card. */
  abnormal: number;
  firstAbnormal: string | null;
}

export interface HealthItem {
  id: string;
  kind: HealthKind;
  status: HealthStatus;
  /** Both languages travel together. `mcp_connectors` has `name_zh`/`name_en`
   *  and `provider_keys` has only a free-text `label`; picking one server-side
   *  would show Chinese on an English console. */
  nameZh: string;
  nameEn: string;
  latencyMs: number | null;
  lastTestAt: string | null;
}

export interface HealthBlock {
  /** Newest `lastTestAt` among the rows THIS caller may see. */
  checkedAt: string | null;
  items: HealthItem[];
}

export interface ActivityItem {
  id: string;
  ts: string;
  action: string;
  actionZh: string;
  actionEn: string;
  tone: string;
  targetType: string | null;
  targetNameZh: string | null;
  targetNameEn: string | null;
  /** null = a system action. The browser renders the word "system"; the server
   *  ships neither Chinese nor English for it. */
  userId: string | null;
  userName: string | null;
}

export interface DashboardSummary {
  users: UserCounts | null;
  agents: AgentCounts | null;
  mcp: McpCounts | null;
  health: HealthBlock | null;
  activities: ActivityItem[] | null;
}

/** Anything Postgres may hand back for a count. */
function n(value: unknown): number {
  return Number(value ?? 0);
}

export async function queryUserCounts(orgId: string): Promise<UserCounts> {
  const r = await pool.query<{
    total: string | number;
    enabled: string | number;
    disabled: string | number;
  }>(
    `SELECT COUNT(*)::bigint AS total,
            COUNT(*) FILTER (WHERE status = 'active')::bigint AS enabled,
            COUNT(*) FILTER (WHERE status = 'disabled')::bigint AS disabled
     FROM users WHERE org_id = $1`,
    [orgId]
  );
  const row = r.rows[0];
  return { total: n(row?.total), enabled: n(row?.enabled), disabled: n(row?.disabled) };
}

/**
 * The org's own agent catalog, per migration 053.
 *
 * Before it, this counted a platform-wide table and every org read the same
 * number — which was also a live isolation hole, since the agent admin list was
 * an unqualified SELECT and any org admin could edit or delete any other org's
 * agents. Counting per org is only half the fix; the routes were scoped in the
 * same change.
 */
export async function queryAgentCounts(orgId: string): Promise<AgentCounts> {
  const r = await pool.query<{ enabled: string | number; total: string | number }>(
    `SELECT COUNT(*) FILTER (WHERE enabled)::bigint AS enabled, COUNT(*)::bigint AS total
     FROM agent_marketplace_agents WHERE org_id = $1`,
    [orgId]
  );
  const row = r.rows[0];
  return { enabled: n(row?.enabled), total: n(row?.total) };
}

export async function queryMcpCounts(orgId: string): Promise<McpCounts> {
  const r = await pool.query<{
    total: string | number;
    enabled: string | number;
    abnormal: string | number;
    first_abnormal: string | null;
  }>(
    `SELECT COUNT(*)::bigint AS total,
            COUNT(*) FILTER (WHERE enabled)::bigint AS enabled,
            COUNT(*) FILTER (WHERE enabled AND last_test_status = 'failed')::bigint AS abnormal,
            (SELECT COALESCE(NULLIF(name_zh, ''), NULLIF(name_en, ''), server_key)
               FROM mcp_connectors m2
              WHERE m2.org_id = $1 AND m2.enabled AND m2.last_test_status = 'failed'
              ORDER BY m2.last_test_at DESC NULLS LAST
              LIMIT 1) AS first_abnormal
     FROM mcp_connectors m WHERE m.org_id = $1`,
    [orgId]
  );
  const row = r.rows[0];
  return {
    total: n(row?.total),
    enabled: n(row?.enabled),
    abnormal: n(row?.abnormal),
    firstAbnormal: row?.first_abnormal ?? null,
  };
}

/** Latency above this is surfaced as `warn`.
 *
 *  The spec's rule is "timeout rate > 3% or P95 > 3s", which needs a history of
 *  samples. Nothing in this schema keeps one — a manual test writes a single
 *  latency — so this is an APPROXIMATION of the P95 threshold, not the spec's
 *  rule. Recorded here so nobody later reads the orange dot as equivalent. */
const WARN_LATENCY_MS = 3000;

function healthStatus(testedOk: boolean, latencyMs: number | null): HealthStatus {
  if (!testedOk) return 'err';
  if (latencyMs !== null && latencyMs > WARN_LATENCY_MS) return 'warn';
  return 'ok';
}

/** `err` → `warn` → `ok` → `unknown`, newest probe first inside each band.
 *  Never tested sorts last on purpose: the six slots belong to what is known
 *  to be broken or known to be fine. */
const STATUS_ORDER: Record<HealthStatus, number> = { err: 0, warn: 1, ok: 2, unknown: 3 };

function sortHealth(items: HealthItem[]): HealthItem[] {
  return items.sort((a, b) => {
    const byStatus = STATUS_ORDER[a.status] - STATUS_ORDER[b.status];
    if (byStatus !== 0) return byStatus;
    // `unknown` rows all carry a null timestamp; nullsLast keeps them stable.
    const at = a.lastTestAt ? Date.parse(a.lastTestAt) : Number.NEGATIVE_INFINITY;
    const bt = b.lastTestAt ? Date.parse(b.lastTestAt) : Number.NEGATIVE_INFINITY;
    return bt - at;
  });
}

export async function queryHealth(args: {
  orgId: string;
  includeModel: boolean;
  includeMcp: boolean;
  limit?: number;
}): Promise<HealthBlock> {
  const items: HealthItem[] = [];

  if (args.includeModel) {
    const r = await pool.query<{
      id: string;
      label: string | null;
      provider: string;
      status: string;
      latency_ms: string | number | null;
      last_test_at: Date | string | null;
    }>(
      `SELECT id, label, provider, status, latency_ms, last_test_at
       FROM provider_keys WHERE org_id = $1`,
      [args.orgId]
    );
    for (const row of r.rows) {
      const latencyMs = row.latency_ms === null ? null : n(row.latency_ms);
      const testedAt = row.last_test_at ? new Date(row.last_test_at).toISOString() : null;
      const name = row.label?.trim() ? row.label : row.provider;
      items.push({
        id: row.id,
        kind: 'model',
        status: testedAt ? healthStatus(row.status === 'connected', latencyMs) : 'unknown',
        nameZh: name,
        nameEn: name,
        latencyMs,
        lastTestAt: testedAt,
      });
    }
  }

  if (args.includeMcp) {
    const r = await pool.query<{
      id: string;
      server_key: string;
      name_zh: string | null;
      name_en: string | null;
      last_test_status: string | null;
      last_latency_ms: string | number | null;
      last_test_at: Date | string | null;
    }>(
      `SELECT id, server_key, name_zh, name_en, last_test_status, last_latency_ms, last_test_at
       FROM mcp_connectors WHERE org_id = $1`,
      [args.orgId]
    );
    for (const row of r.rows) {
      const latencyMs = row.last_latency_ms === null ? null : n(row.last_latency_ms);
      const testedAt = row.last_test_at ? new Date(row.last_test_at).toISOString() : null;
      const zh = row.name_zh?.trim() || row.name_en?.trim() || row.server_key;
      const en = row.name_en?.trim() || row.name_zh?.trim() || row.server_key;
      items.push({
        id: row.id,
        kind: 'mcp',
        status: testedAt
          ? healthStatus(row.last_test_status === 'connected', latencyMs)
          : 'unknown',
        nameZh: zh,
        nameEn: en,
        latencyMs,
        lastTestAt: testedAt,
      });
    }
  }

  const sorted = sortHealth(items);
  return {
    // Computed AFTER trimming and sorting, from what the caller may see. Taking
    // MAX over everything would let a caller without `provider:view` watch the
    // model-side timestamp move and infer that a probe had just run.
    checkedAt: sorted.find((i) => i.lastTestAt)?.lastTestAt ?? null,
    items: sorted.slice(0, args.limit ?? 6),
  };
}

/**
 * One name-resolution query for a target type.
 *
 * `sql` is built from the placeholders the caller binds rather than typed
 * into a string, so the id array and the org id can never be swapped.
 */
interface TargetNameQuery {
  sql: (idsParam: string, orgParam: string) => string;
  /** False for a platform-wide catalog that carries no org filter. */
  orgScoped: boolean;
}

/**
 * Where a target's display name lives, keyed by the SAME `target_type` codes
 * the audit writers use (`src/shared/auditTargetTypeMeta.ts`'s
 * `KNOWN_TARGET_TYPES`) — an MCP connector is audited as `connector`, not
 * `mcp_connector`, and a map keyed off a plausible-looking guess silently
 * resolves nothing.
 *
 * `queryAudit` returns `target_id`, which for most resources is a UUID. Showing
 * one to an admin is not a degraded experience, it is a bug. Types absent from
 * this table fall back to a `name`/`username` field on the payload, and then to
 * null — the browser renders a shorter sentence rather than inventing a label.
 */
const TARGET_NAME_SQL: Record<string, TargetNameQuery> = {
  connector: {
    orgScoped: true,
    sql: (ids, org) => `SELECT id, COALESCE(NULLIF(name_zh,''), NULLIF(name_en,''), server_key) AS zh,
                                COALESCE(NULLIF(name_en,''), NULLIF(name_zh,''), server_key) AS en
                         FROM mcp_connectors WHERE org_id = ${org} AND id = ANY(${ids})`,
  },
  connector_category: {
    orgScoped: true,
    sql: (ids, org) => `SELECT id, name AS zh, name AS en
                         FROM mcp_connector_categories WHERE org_id = ${org} AND id = ANY(${ids})`,
  },
  provider_key: {
    orgScoped: true,
    sql: (ids, org) => `SELECT id, COALESCE(NULLIF(label,''), provider) AS zh,
                              COALESCE(NULLIF(label,''), provider) AS en
                       FROM provider_keys WHERE org_id = ${org} AND id = ANY(${ids})`,
  },
  model: {
    orgScoped: true,
    sql: (ids, org) => `SELECT id, COALESCE(NULLIF(display_name,''), model) AS zh,
                               COALESCE(NULLIF(display_name,''), model) AS en
                        FROM model_catalog WHERE org_id = ${org} AND id = ANY(${ids})`,
  },
  agent: {
    orgScoped: true,
    sql: (ids, org) => `SELECT agent_id AS id, name AS zh, name AS en
                        FROM agent_marketplace_agents WHERE org_id = ${org} AND agent_id = ANY(${ids})`,
  },
  user: {
    orgScoped: true,
    sql: (ids, org) => `SELECT id, COALESCE(NULLIF(display_name,''), username) AS zh,
                              COALESCE(NULLIF(display_name,''), username) AS en
                       FROM users WHERE org_id = ${org} AND id = ANY(${ids})`,
  },
  dept: {
    orgScoped: true,
    sql: (ids, org) => `SELECT id, name AS zh, name AS en
                       FROM departments WHERE org_id = ${org} AND id = ANY(${ids})`,
  },
  role: {
    orgScoped: false,
    sql: (ids) => `SELECT id, name AS zh, name AS en
                   FROM roles WHERE id = ANY(${ids})`,
  },
  // The two catalog tables were born bilingual (023 / 040) and key differently:
  // a kit is identified by its `slug`, a skill by `skill_id`. Querying `name` or
  // `kit_id` here is not a soft miss — it is a `42703` that aborts the whole
  // summary request, so a single skill edit in the last 7 days blanked the
  // dashboard for every caller with `audit:view`.
  kit: {
    orgScoped: true,
    sql: (ids, org) => `SELECT slug AS id,
                               COALESCE(NULLIF(name_zh,''), name_en) AS zh,
                               COALESCE(NULLIF(name_en,''), name_zh) AS en
                        FROM kit_catalog WHERE org_id = ${org} AND slug = ANY(${ids})`,
  },
  skill: {
    orgScoped: true,
    sql: (ids, org) => `SELECT skill_id AS id,
                               COALESCE(NULLIF(name_zh,''), name_en) AS zh,
                               COALESCE(NULLIF(name_en,''), name_zh) AS en
                        FROM skill_marketplace_skills WHERE org_id = ${org} AND skill_id = ANY(${ids})`,
  },
};

/** Audit windows are half-open `[from, to)`. */
function payloadName(payload: unknown, key: 'name' | 'username'): string | null {
  if (!payload || typeof payload !== 'object') return null;
  const v = (payload as Record<string, unknown>)[key];
  return typeof v === 'string' && v.trim() ? v : null;
}

export async function queryActivities(orgId: string, limit = 6): Promise<ActivityItem[]> {
  // A fixed 7-day window: this feed does not follow the page's range selector
  // (the spec puts 最近动态 in the "does not change with range" group), so it
  // needs its own bound rather than inheriting one that moves under it.
  const { from, to } = await resolveUsageRange(orgId, UsageRange.Last7Days);
  const result = await queryAudit({
    orgId,
    from,
    to,
    filters: { exclude: [AuditAction.ProviderCall] },
    // Failed sign-ins write NO `audit_events` row — they live only in
    // `login_events`. Without the union the one class of event an admin most
    // wants on a landing page is the one class that cannot appear.
    includeLogin: true,
    page: 1,
    pageSize: limit,
  });

  // Group by target type so each type costs one query, not one per row.
  // `AuditListItem` is the wire shape, so these fields are snake_case here.
  const idsByType = new Map<string, Set<string>>();
  for (const item of result.items) {
    if (!item.target_type || !item.target_id) continue;
    const set = idsByType.get(item.target_type) ?? new Set<string>();
    set.add(item.target_id);
    idsByType.set(item.target_type, set);
  }

  const namesByKey = new Map<string, { zh: string; en: string }>();
  await Promise.all(
    [...idsByType.entries()].map(async ([type, ids]) => {
      const query = TARGET_NAME_SQL[type];
      if (!query) return;
      // The id array is always $1; an org filter takes $2. The SQL is built
      // from those placeholders, so the two can never be bound the wrong way
      // round — an earlier version inferred the layout from the SQL text and
      // the agent entry had it backwards, which made the whole activity feed
      // fail with `malformed array literal`.
      const params = query.orgScoped ? [[...ids], orgId] : [[...ids]];
      const r = await pool.query<{ id: string; zh: string | null; en: string | null }>(
        query.sql('$1', '$2'),
        params,
      );
      for (const row of r.rows) {
        namesByKey.set(`${type}:${row.id}`, { zh: row.zh ?? '', en: row.en ?? '' });
      }
    })
  );

  return result.items.map((item) => {
    const hit =
      item.target_type && item.target_id
        ? namesByKey.get(`${item.target_type}:${item.target_id}`)
        : undefined;
    const fallbackZh = payloadName(item.payload, 'name');
    const fallbackEn = payloadName(item.payload, 'username');
    return {
      id: item.id,
      ts: item.ts,
      action: item.action,
      actionZh: item.action_zh,
      actionEn: item.action_en,
      tone: item.tone,
      targetType: item.target_type,
      targetNameZh: hit?.zh || fallbackZh,
      targetNameEn: hit?.en || fallbackEn || fallbackZh,
      userId: item.user_id,
      userName: item.user_name,
    };
  });
}
// ---------------------------------------------------------------------------
// Usage side
// ---------------------------------------------------------------------------

export type TrendGranularity = 'hour' | 'day';

export interface UsageTotals {
  value: number;
  prev: number;
}

export interface TrendPoint {
  /** `YYYY-MM-DD` for a day bucket, `YYYY-MM-DDTHH` for an hour bucket. */
  key: string;
  /** Already localised for the axis: `04/09` or `09:00`. */
  label: string;
  tokens: number;
  calls: number;
}

export interface TrendSeries {
  granularity: TrendGranularity;
  points: TrendPoint[];
}

export interface ModelUsageRow {
  provider: string;
  model: string;
  displayName: string;
  tokens: number;
  calls: number;
}

export interface DeptUsageRow {
  /** null = the member has no department; `name` is null too, and the browser
   *  renders the "unassigned" label from its own dictionary. */
  departmentId: string | null;
  name: string | null;
  users: number;
  tokens: number;
}

export interface DashboardUsage {
  range: string;
  from: string;
  to: string;
  timezone: string;
  active: UsageTotals;
  tokens: UsageTotals;
  unaccountedCalls: number;
  trend: TrendSeries;
  modelTop: ModelUsageRow[];
  deptTop: DeptUsageRow[];
}

/**
 * `token_usage.total_tokens` is INTEGER, so a plain `SUM` overflows past
 * 2,147,483,647 and Postgres RAISES — not wraps, raises. Every sum here casts
 * to bigint first. `queryModels` casts for the same reason.
 */
async function windowSums(
  orgId: string,
  from: Date,
  to: Date
): Promise<{ activeUsers: number; tokens: number; missing: number }> {
  const r = await pool.query<{
    active_users: string | number;
    tokens: string | number;
    missing: string | number;
  }>(
    `SELECT COUNT(DISTINCT user_id)::bigint AS active_users,
            COALESCE(SUM(total_tokens), 0)::bigint AS tokens,
            COUNT(*) FILTER (WHERE usage_missing)::bigint AS missing
     FROM token_usage WHERE org_id = $1 AND ts >= $2 AND ts < $3`,
    [orgId, from, to]
  );
  const row = r.rows[0];
  return {
    activeUsers: n(row?.active_users),
    tokens: n(row?.tokens),
    missing: n(row?.missing),
  };
}

/**
 * One bucket query, parameterised by granularity. The day and hour forms
 * differ only in the `date_trunc` unit, so they share every predicate rather
 * than being written twice — a second copy is where the two drift.
 */
async function trendQuery(
  orgId: string,
  from: Date,
  to: Date,
  timezone: string,
  granularity: TrendGranularity
): Promise<Map<string, { tokens: number; calls: number }>> {
  const expr =
    granularity === 'hour'
      ? `to_char(date_trunc('hour', ts AT TIME ZONE $4), 'YYYY-MM-DD"T"HH24')`
      : `to_char(ts AT TIME ZONE $4, 'YYYY-MM-DD')`;
  const r = await pool.query<{ bucket: string; tokens: string | number; calls: string | number }>(
    `SELECT ${expr} AS bucket,
            COALESCE(SUM(total_tokens), 0)::bigint AS tokens,
            COUNT(*)::bigint AS calls
     FROM token_usage
     WHERE org_id = $1 AND ts >= $2 AND ts < $3
     GROUP BY 1`,
    [orgId, from, to, timezone]
  );
  const out = new Map<string, { tokens: number; calls: number }>();
  for (const row of r.rows) {
    out.set(row.bucket, { tokens: n(row.tokens), calls: n(row.calls) });
  }
  return out;
}

/** `04/09` from `2026-04-09`. Sliced, never parsed: a `Date` built from a bare
 *  date string is UTC midnight, which renders as the previous day west of
 *  Greenwich. */
function dayLabel(key: string): string {
  const m = /^\d{4}-(\d{2})-(\d{2})$/.exec(key);
  return m ? `${m[1]}/${m[2]}` : key;
}

function hourLabel(key: string): string {
  const m = /^\d{4}-\d{2}-\d{2}T(\d{2})$/.exec(key);
  return m ? `${m[1]}:00` : key;
}

/**
 * Roll sub-departments up to their top-level ancestor so the ranking reads
 * "which part of the company", not "which leaf box on the org chart".
 *
 * The recursive CTE is the honest way to do it: `departments.path` is built
 * from NAMES, so prefix-matching on it would break the moment a department is
 * renamed, and joining on `parent_id` alone would only give one level.
 */
const DEPT_ROOT_CTE = `
  WITH RECURSIVE dept_root AS (
    SELECT d.id, d.id AS root_id, d.name AS root_name
    FROM departments d
    WHERE d.org_id = $1 AND d.parent_id IS NULL
    UNION ALL
    SELECT c.id, r.root_id, r.root_name
    FROM departments c
    JOIN dept_root r ON c.parent_id = r.id
    WHERE c.org_id = $1
  )
`;

export async function queryDashboardUsage(args: {
  orgId: string;
  range: UsageRange;
  limit?: number;
}): Promise<DashboardUsage> {
  const limit = args.limit ?? 5;
  const { from, to, timezone, key, days } = await resolveUsageRange(args.orgId, args.range);
  const prev = await resolvePreviousUsageRange(args.orgId, args.range);
  const granularity: TrendGranularity = args.range === UsageRange.Today ? 'hour' : 'day';

  const [current, previous, buckets, modelRows, deptRows] = await Promise.all([
    windowSums(args.orgId, from, to),
    windowSums(args.orgId, prev.from, prev.to),
    trendQuery(args.orgId, from, to, timezone, granularity),
    pool.query<{
      provider: string;
      model: string | null;
      display_name: string | null;
      tokens: string | number;
      calls: string | number;
    }>(
      // FROM token_usage, not model_catalog: the usage TABLE lists configured
      // models so an admin can see what is idle, but a TOP 5 ranks actual usage
      // and a zero-token row is noise.
      `SELECT t.provider,
              m.model,
              COALESCE(m.display_name, m.model) AS display_name,
              SUM(t.total_tokens)::bigint AS tokens,
              COUNT(*)::bigint AS calls
       FROM token_usage t
       LEFT JOIN model_catalog m ON m.id = t.model_id
       WHERE t.org_id = $1 AND t.ts >= $2 AND t.ts < $3
       GROUP BY t.provider, m.model, COALESCE(m.display_name, m.model)
       ORDER BY SUM(t.total_tokens) DESC, m.model ASC, t.provider ASC
       LIMIT $4`,
      [args.orgId, from, to, limit]
    ),
    pool.query<{
      root_id: string | null;
      root_name: string | null;
      users: string | number;
      tokens: string | number;
    }>(
      `${DEPT_ROOT_CTE}
       SELECT r.root_id,
              r.root_name,
              COUNT(DISTINCT t.user_id)::bigint AS users,
              COALESCE(SUM(t.total_tokens), 0)::bigint AS tokens
       FROM token_usage t
       JOIN users u ON u.id = t.user_id AND u.org_id = $1
       LEFT JOIN dept_root r ON r.id = u.department_id
       WHERE t.org_id = $1 AND t.ts >= $2 AND t.ts < $3
       GROUP BY r.root_id, r.root_name
       ORDER BY COALESCE(SUM(t.total_tokens), 0) DESC, r.root_name ASC NULLS LAST
       LIMIT $4`,
      [args.orgId, from, to, limit]
    ),
  ]);

  // Every bucket in the window gets a point, zero included: dropping empty
  // slots would let a busy Tuesday draw a bar twice as wide as its neighbours.
  // The key list comes from the RESOLVED WINDOW, never from the rows that came
  // back — a quiet day is a real day with a zero on it.
  const keys = granularity === 'hour' ? hourKeysUpToNow(from, new Date(), timezone) : days;
  const points: TrendPoint[] = keys.map((k) => {
    const hit = buckets.get(k);
    return {
      key: k,
      label: granularity === 'hour' ? hourLabel(k) : dayLabel(k),
      tokens: hit?.tokens ?? 0,
      calls: hit?.calls ?? 0,
    };
  });

  return {
    range: key,
    from: from.toISOString(),
    to: to.toISOString(),
    timezone,
    active: { value: current.activeUsers, prev: previous.activeUsers },
    tokens: { value: current.tokens, prev: previous.tokens },
    unaccountedCalls: current.missing,
    trend: { granularity, points },
    modelTop: modelRows.rows.map((r) => ({
      provider: r.provider,
      model: r.model ?? '',
      displayName: r.display_name ?? r.model ?? '',
      tokens: n(r.tokens),
      calls: n(r.calls),
    })),
    deptTop: deptRows.rows.map((r) => ({
      departmentId: r.root_id,
      name: r.root_name,
      users: n(r.users),
      tokens: n(r.tokens),
    })),
  };
}

/**
 * The hour buckets a `today` window has actually reached: local midnight up to
 * and including the hour containing "now".
 *
 * Derived from the window's own start instant so the first label cannot drift
 * from the day the range resolver picked, and stepped in real hours so the
 * spacing stays exactly 60 minutes even across a DST transition (where a local
 * hour can be 23 or 25 hours long). Labels come from Intl, so they remain
 * correct local times either way.
 */
function hourKeysUpToNow(windowStart: Date, now: Date, timezone: string): string[] {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    hourCycle: 'h23',
  });
  const start = new Date(windowStart);
  start.setUTCMinutes(0, 0, 0);
  const keys: string[] = [];
  for (let t = start.getTime(); t <= now.getTime(); t += 3_600_000) {
    const parts = fmt.formatToParts(new Date(t));
    const get = (type: string): string => parts.find((p) => p.type === type)?.value ?? '';
    keys.push(`${get('year')}-${get('month')}-${get('day')}T${get('hour') || '00'}`);
  }
  return keys;
}
