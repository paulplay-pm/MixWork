import { pool } from '../db/pool';

/** A single merged row in the model-usage table. (provider, model) is the
 * merged identity: two catalog entries with the same upstream model name but
 * different provider keys (the migration 039 case: a built-in `deepseek` key
 * plus a custom `deepseek` key for the same vendor) are aggregated into one
 * row, not split by `model_id`. */
export interface UsageModelRow {
  provider: string;
  model: string;
  display_name: string;
  total_tokens: number;
  call_count: number;
}

export interface UsageModelsResult {
  page: number;
  pageSize: number;
  total: number;
  items: UsageModelRow[];
  unaccounted_calls: number;
}

// Shared CTE block. Both the page query and the aggregates query need
// catalog_agg + usage_agg + joined; the definitions are duplicated across
// the two SQL strings, but they are LITERAL — the planner sees the same
// shape and any future predicate added must be added to both copies in
// lockstep. Both queries run with $1=org_id, $2=from, $3=to; the page
// query additionally binds $4=pageSize, $5=offset.
const CTES = `
  catalog_agg AS (
    SELECT provider, model, MAX(display_name) AS display_name
    FROM model_catalog
    WHERE org_id = $1
    GROUP BY provider, model
  ),
  usage_agg AS (
    SELECT t.provider, m.model,
           COALESCE(SUM(t.total_tokens), 0)::bigint AS total_tokens,
           COUNT(*)::bigint AS call_count,
           COUNT(*) FILTER (WHERE t.usage_missing)::bigint AS missing_total
    FROM token_usage t
    LEFT JOIN model_catalog m ON m.id = t.model_id
    WHERE t.org_id = $1 AND t.ts >= $2 AND t.ts < $3
    GROUP BY t.provider, m.model
  ),
  joined AS (
    SELECT
      c.provider AS catalog_provider,
      u.provider AS usage_provider,
      c.model    AS catalog_model,
      u.model    AS usage_model,
      c.display_name,
      COALESCE(u.total_tokens, 0)::bigint AS total_tokens,
      COALESCE(u.call_count,    0)::bigint AS call_count
    FROM catalog_agg c
    FULL JOIN usage_agg u
      ON c.provider = u.provider AND c.model = u.model
  )
`;

/**
 * The one model statement, parameterised by its paging window.
 *
 * `paging` is `LIMIT $4 OFFSET $5` for the table and the empty string for the
 * CSV export. Keeping both windows on a single template is the whole point:
 * a second copy of this SQL is how the export and the table start disagreeing
 * about which models exist, in what order, or how a row is summed — and a
 * "page size of 100000" would look identical here while silently truncating a
 * real export. The row mapper below is shared the same way, so a dropped
 * `Number()` cannot survive in one path only.
 *
 * `modelFilter` is the dashboard's deep link: clicking a row in 模型用量 TOP 5
 * lands here and must find that model even when it is not on page 1. It is
 * applied INSIDE the template (rather than in JS after the fetch) so the
 * aggregate count narrows with it — a table that filtered its rows but reported
 * the unfiltered `total` would show "page 1 of 3" for a one-row result.
 */
function modelsQuery(paging: string, modelFilter = false): string {
  const where = modelFilter
    ? `WHERE COALESCE(catalog_provider, usage_provider) = $4
       AND COALESCE(catalog_model, usage_model) = $5`
    : '';
  return `
  WITH ${CTES}
  SELECT
    COALESCE(catalog_provider, usage_provider) AS provider,
    COALESCE(catalog_model,    usage_model)    AS model,
    display_name,
    total_tokens,
    call_count
  FROM joined
  ${where}
  ORDER BY
    COALESCE(total_tokens, 0) DESC,
    COALESCE(catalog_model, usage_model) ASC,
    COALESCE(catalog_provider, usage_provider) ASC
  ${paging}
`;
}

const PAGE_QUERY = modelsQuery('LIMIT $4 OFFSET $5');
const PAGE_QUERY_FILTERED = modelsQuery('LIMIT $6 OFFSET $7', true);

/** `pg` hands `bigint` back as a string; pglite hands back a number. One
 * mapper for both paths, so the coercion cannot be present in one and missing
 * in the other. */
function mapModelRows(
  rows: {
    provider: string | null;
    model: string | null;
    display_name: string | null;
    total_tokens: string | null;
    call_count: string | null;
  }[],
): UsageModelRow[] {
  return rows.map((row) => ({
    provider: row.provider ?? '',
    model: row.model ?? '',
    display_name: row.display_name ?? row.model ?? '',
    total_tokens: Number(row.total_tokens ?? 0),
    call_count: Number(row.call_count ?? 0),
  }));
}

// Deliberately a SECOND statement rather than a window `COUNT(*) OVER ()` on the
// page query: `Promise.all` runs the two independently, so a `token_usage` write
// landing between them can leave `total` one row ahead of `items` (R26). Traded
// knowingly — a window function would buy atomicity at the cost of counting every
// row in the org on every page — and self-correcting on the next fetch.
const AGGREGATES_QUERY = `
  WITH ${CTES}
  SELECT
    (SELECT COUNT(*)::bigint FROM joined) AS grand_total,
    (SELECT COALESCE(SUM(missing_total), 0)::bigint FROM usage_agg) AS missing_total
`;

/** Same statement, narrowed to one (provider, model) for the deep-link filter. */
const AGGREGATES_QUERY_FILTERED = `
  WITH ${CTES}
  SELECT
    (SELECT COUNT(*)::bigint FROM joined
      WHERE COALESCE(catalog_provider, usage_provider) = $4
        AND COALESCE(catalog_model, usage_model) = $5) AS grand_total,
    (SELECT COALESCE(SUM(missing_total), 0)::bigint FROM usage_agg) AS missing_total
`;

/**
 * Aggregate the model-usage table for [from, to) inside one org.
 *
 * The data model after migration 039 has `model_catalog.unique = (org_id,
 * provider_key_id, model)`, so the same upstream model can appear twice
 * (once under a builtin provider key and once under a custom key for the
 * same vendor). Joining on `model_id` would duplicate rows and split the
 * tokens.
 *
 * The fix aggregates the two sides and combines with FULL JOIN:
 *
 *   LEFT side (catalog_agg):  GROUP BY (provider, model) — captures the
 *                            no-calls-in-range case the PRD requires
 *                            (configured models stay visible at 0).
 *                            display_name is MAX-aggregated independently;
 *                            grouping by it would re-split same-named
 *                            models by their (potentially distinct) labels.
 *
 *   RIGHT side (usage_agg):   LEFT JOIN token_usage onto model_catalog on
 *                            model_id so the GROUP BY has the upstream-
 *                            facing model name in hand. Orphaned usage
 *                            rows are impossible here — `token_usage.
 *                            model_id REFERENCES model_catalog(id)` has
 *                            no ON DELETE (default NO ACTION) and
 *                            modelCatalog.remove is a hard DELETE that
 *                            blocks as long as any child row references
 *                            the parent.
 *
 * The aggregates (`total`, `unaccounted_calls`) come from a SECOND query
 * that runs unconditionally — independent of LIMIT/OFFSET — so a page
 * past the end still reports the true totals (the I-1 fix). Running
 * them through Promise.all keeps the round-trip count to two for any
 * page, including empty pages; the page query and the aggregates query
 * share CTEs but each is its own statement (no UNION tricks), so adding
 * a predicate to one and forgetting the other cannot silently desync
 * the two paths.
 *
 * `::bigint` (not `::int`) on every aggregate. A pair of rows at
 * 2,147,483,647 tokens each sums to 4.3e9, above the int4 ceiling;
 * `::int` would raise `integer out of range` and 500 the route. The
 * pg driver hands `bigint` back as a string, so the mapper runs each
 * through `Number()` (exact to 2^53 — well past any realistic month's
 * worth of tokens). A unit test against a stubbed pool that returns
 * strings as-strings pins the contract.
 *
 * `ORDER BY` has `provider ASC` as a final tiebreaker so equal-token
 * rows across providers land in stable alphabetical order; without it
 * the relative order is undefined.
 */
export async function queryModels(args: {
  orgId: string;
  from: Date;
  to: Date;
  page: number;
  pageSize: number;
  /** Dashboard deep link: the single `(provider, model)` to isolate. Omitted
   *  means no narrowing, which is the table's normal behaviour. */
  model?: { provider: string; model: string };
}): Promise<UsageModelsResult> {
  const pageSize = Math.max(1, Math.floor(args.pageSize));
  const page = Math.max(1, Math.floor(args.page));
  const offset = (page - 1) * pageSize;
  const filter = args.model;

  const [pageResult, aggResult] = await Promise.all([
    pool.query<{
      provider: string | null;
      model: string | null;
      display_name: string | null;
      total_tokens: string | null;
      call_count: string | null;
    }>(
      filter ? PAGE_QUERY_FILTERED : PAGE_QUERY,
      filter
        ? [args.orgId, args.from, args.to, filter.provider, filter.model, pageSize, offset]
        : [args.orgId, args.from, args.to, pageSize, offset]
    ),
    pool.query<{ grand_total: string; missing_total: string }>(
      filter ? AGGREGATES_QUERY_FILTERED : AGGREGATES_QUERY,
      filter
        ? [args.orgId, args.from, args.to, filter.provider, filter.model]
        : [args.orgId, args.from, args.to],
    ),
  ]);

  const items = mapModelRows(pageResult.rows);
  const aggRow = aggResult.rows[0];
  const total = Number(aggRow?.grand_total ?? 0);
  const unaccounted_calls = Number(aggRow?.missing_total ?? 0);

  return { page, pageSize, total, items, unaccounted_calls };
}

/**
 * Every merged model row in [from, to), with no paging window at all.
 *
 * This is the CSV export's only data source. It deliberately does NOT call
 * `queryModels` with a huge pageSize: that would inherit the clamping the
 * table route applies, so an org with more models than the cap would export a
 * truncated file that still claims a row count. Running the same base SQL with
 * the window dropped means `items.length` is the true total by construction,
 * which is what makes the export's `x-export-count` agree with the table's
 * `total` rather than merely resemble it.
 *
 * No aggregates query here: with no LIMIT/OFFSET the row list IS the total,
 * and a second statement would only be a second thing to drift.
 */
export async function queryModelsAll(args: {
  orgId: string;
  from: Date;
  to: Date;
}): Promise<UsageModelRow[]> {
  const result = await pool.query<{
    provider: string | null;
    model: string | null;
    display_name: string | null;
    total_tokens: string | null;
    call_count: string | null;
  }>(modelsQuery(''), [args.orgId, args.from, args.to]);

  return mapModelRows(result.rows);
}

/** One row of the member-usage table. */
export interface UsageUserRow {
  user_id: string;
  username: string;
  display_name: string | null;
  department_name: string | null;
  total_tokens: number;
  last_used_at: string | null;
}

export interface UsageUsersResult {
  page: number;
  pageSize: number;
  total: number;
  items: UsageUserRow[];
  unaccounted_calls: number;
}

export const UsageUserSort = { Desc: 'desc', Asc: 'asc' } as const;
export type UsageUserSort = (typeof UsageUserSort)[keyof typeof UsageUserSort];

// `sort` reaches the SQL as text, so it is validated against a closed set
// rather than passed through. Anything unrecognised reads as `desc`, which is
// also the documented default.
function sortDirection(sort: UsageUserSort): 'ASC' | 'DESC' {
  return sort === UsageUserSort.Asc ? 'ASC' : 'DESC';
}

/**
 * `q` is matched with ILIKE, so `%`, `_` and the escape character itself have
 * to be neutralised or a stray `%` in the search box matches every row. The
 * backslash is the default LIKE escape in Postgres, so doubling it here is
 * enough — no ESCAPE clause needed.
 */
function likePattern(q: string): string {
  return `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
}

// Shared CTE block, the same shape as the models query above: `usage_agg` is
// scoped to the org and the half-open window only, and `roster` is scoped to
// the org (never to `users.status` — see the D6 note on queryUsers).
//
// Both statements run with $1=org_id, $2=from, $3=to, $4=pattern; the page
// query additionally binds $5=pageSize, $6=offset. The pattern is always
// bound, as '%%' when there is no search, so one statement shape serves both
// the searching and non-searching case.
const USERS_CTES = `
  usage_agg AS (
    SELECT t.user_id,
           COALESCE(SUM(t.total_tokens), 0)::bigint AS total_tokens,
           MAX(t.ts) AS last_used_at,
           COUNT(*) FILTER (WHERE t.usage_missing)::bigint AS missing_total
    FROM token_usage t
    WHERE t.org_id = $1 AND t.ts >= $2 AND t.ts < $3
    GROUP BY t.user_id
  ),
  roster AS (
    SELECT u.id AS user_id,
           u.username,
           u.display_name,
           d.name AS department_name
    FROM users u
    LEFT JOIN departments d ON d.id = u.department_id AND d.org_id = u.org_id
    WHERE u.org_id = $1
      AND (COALESCE(u.display_name, '') ILIKE $4 OR u.username ILIKE $4)
  ),
  joined AS (
    SELECT r.user_id,
           r.username,
           r.display_name,
           r.department_name,
           COALESCE(a.total_tokens, 0)::bigint AS total_tokens,
           a.last_used_at
    FROM roster r
    LEFT JOIN usage_agg a ON a.user_id = r.user_id
  )
`;

// The tiebreaker after `total_tokens` is load-bearing. Every member with no
// calls in range has total_tokens = 0, so without a unique final key the rows
// tie and the LIMIT/OFFSET boundary moves between requests — the same person
// lands on two pages and another on none. `COALESCE(display_name, username)`
// ASC then `user_id ASC` (the primary key, therefore unique) makes the order
// total and paging deterministic by the SQL alone. The tiebreaker is ascending
// in BOTH directions; only the token key flips with `sort`.
//
// `paging` is `LIMIT $5 OFFSET $6` for the table and the empty string for the
// CSV export — one template, two windows, so the export cannot order or shape
// its rows differently from the table it claims to be a copy of.
function usersPageQuery(sort: UsageUserSort, paging: string): string {
  return `
  WITH ${USERS_CTES}
  SELECT user_id, username, display_name, department_name, total_tokens, last_used_at
  FROM joined
  ORDER BY
    total_tokens ${sortDirection(sort)},
    COALESCE(display_name, username) ASC,
    user_id ASC
  ${paging}
`;
}

const USERS_AGGREGATES_QUERY = `
  WITH ${USERS_CTES}
  SELECT
    (SELECT COUNT(*)::bigint FROM joined) AS roster_total,
    (SELECT COALESCE(SUM(missing_total), 0)::bigint FROM usage_agg) AS missing_total
`;

/**
 * `pg` hands `timestamptz` back as a JS Date and `bigint` as a string; pglite
 * hands the latter back as a number. Normalising both here means the exported
 * type is honest on either driver instead of depending on which one the test
 * suite happens to run against.
 */
function toIso(value: Date | string | null): string | null {
  if (value === null || value === undefined) return null;
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

/**
 * The full member roster with each member's usage in [from, to).
 *
 * `users` is the LEFT table (D6): every member of the org is a row, with or
 * without calls. Two absences are deliberate:
 *
 *  - No `status` filter. A disabled member still consumed tokens while they
 *    were enabled, and an admin counting "who used nothing" wants the whole
 *    headcount, not the active subset.
 *  - No `user_archives` filter. That table holds workspace snapshots; it says
 *    nothing about whether the `users` row exists, so joining it would drop
 *    live members whose workspace happened to be archived.
 *
 * `total` and `unaccounted_calls` come from a second, unconditional statement
 * that shares the CTEs (the same I-1 fix as `queryModels`) — reading them off
 * the page's first row collapses both to 0 as soon as `page` runs past the
 * end. `unaccounted_calls` is deliberately computed over `usage_agg` and not
 * over the joined roster, so it stays org-wide in range and is identical on
 * every page and under every search filter.
 */
export interface UsageUsersQuery {
  orgId: string;
  from: Date;
  to: Date;
  q?: string;
  sort: UsageUserSort;
  page: number;
  pageSize: number;
}

/** Shared by the paged and the unbounded read, so the two cannot disagree
 * about how a member row is shaped. `last_used_at` goes through `toIso`
 * because `pg` returns a Date and pglite a string. */
function mapUserRows(
  rows: {
    user_id: string;
    username: string;
    display_name: string | null;
    department_name: string | null;
    total_tokens: string | null;
    last_used_at: Date | string | null;
  }[],
): UsageUserRow[] {
  return rows.map((row) => ({
    user_id: row.user_id,
    username: row.username,
    display_name: row.display_name,
    department_name: row.department_name,
    total_tokens: Number(row.total_tokens ?? 0),
    last_used_at: toIso(row.last_used_at),
  }));
}

export async function queryUsers(args: UsageUsersQuery): Promise<UsageUsersResult> {
  const pageSize = Math.max(1, Math.floor(args.pageSize));
  const page = Math.max(1, Math.floor(args.page));
  const offset = (page - 1) * pageSize;
  const pattern = args.q ? likePattern(args.q) : '%%';

  const [pageResult, aggResult] = await Promise.all([
    pool.query<{
      user_id: string;
      username: string;
      display_name: string | null;
      department_name: string | null;
      total_tokens: string | null;
      last_used_at: Date | string | null;
    }>(usersPageQuery(args.sort, 'LIMIT $5 OFFSET $6'), [
      args.orgId,
      args.from,
      args.to,
      pattern,
      pageSize,
      offset,
    ]),
    pool.query<{ roster_total: string; missing_total: string }>(USERS_AGGREGATES_QUERY, [
      args.orgId,
      args.from,
      args.to,
      pattern,
    ]),
  ]);

  const items = mapUserRows(pageResult.rows);
  const aggRow = aggResult.rows[0];

  return {
    page,
    pageSize,
    total: Number(aggRow?.roster_total ?? 0),
    items,
    unaccounted_calls: Number(aggRow?.missing_total ?? 0),
  };
}

/**
 * The whole roster in [from, to), with no paging window.
 *
 * The CSV export's only data source, and the reason `q` is threaded through
 * rather than dropped: an admin who filtered the table to one member and then
 * exported expects that member's row, not the entire company. The window is
 * removed from the shared template instead of being emulated with a large
 * pageSize, so a roster larger than any cap still exports in full.
 */
export async function queryUsersAll(
  args: Omit<UsageUsersQuery, 'page' | 'pageSize'>,
): Promise<UsageUserRow[]> {
  const pattern = args.q ? likePattern(args.q) : '%%';

  const result = await pool.query<{
    user_id: string;
    username: string;
    display_name: string | null;
    department_name: string | null;
    total_tokens: string | null;
    last_used_at: Date | string | null;
  }>(usersPageQuery(args.sort, ''), [args.orgId, args.from, args.to, pattern]);

  return mapUserRows(result.rows);
}

export interface UserDailyPoint {
  date: string;
  tokens: number;
}

export interface UserModelShare {
  provider: string;
  model: string;
  display_name: string;
  tokens: number;
  pct: number;
}

export interface UserDetailResult {
  user: { user_id: string; display_name: string | null; department_name: string | null } | null;
  daily: UserDailyPoint[];
  by_model: UserModelShare[];
  unaccounted_calls: number;
}

const DETAIL_USER_QUERY = `
  SELECT u.id AS user_id,
         u.display_name,
         d.name AS department_name
  FROM users u
  LEFT JOIN departments d ON d.id = u.department_id AND d.org_id = u.org_id
  WHERE u.org_id = $1 AND u.id = $2
`;

const DETAIL_DAILY_QUERY = `
  SELECT to_char(date_trunc('day', t.ts AT TIME ZONE $5), 'YYYY-MM-DD') AS day,
         COALESCE(SUM(t.total_tokens), 0)::bigint AS tokens
  FROM token_usage t
  WHERE t.org_id = $1 AND t.user_id = $2 AND t.ts >= $3 AND t.ts < $4
  GROUP BY 1
`;

const DETAIL_BY_MODEL_QUERY = `
  SELECT t.provider AS provider,
         m.model AS model,
         MAX(m.display_name) AS display_name,
         COALESCE(SUM(t.total_tokens), 0)::bigint AS tokens
  FROM token_usage t
  LEFT JOIN model_catalog m ON m.id = t.model_id
  WHERE t.org_id = $1 AND t.user_id = $2 AND t.ts >= $3 AND t.ts < $4
  GROUP BY t.provider, m.model
  ORDER BY tokens DESC, model ASC, provider ASC
`;

const DETAIL_MISSING_QUERY = `
  SELECT COUNT(*)::bigint AS missing_total
  FROM token_usage t
  WHERE t.org_id = $1 AND t.user_id = $2 AND t.ts >= $3 AND t.ts < $4
    AND t.usage_missing
`;

/**
 * The per-member drawer: who they are, one bar per day of the range, and their
 * model split.
 *
 * `daily` is assembled in JS from the caller's `days` array rather than by a
 * SQL date-series generator. The resolver already decided which days the range
 * covers — including a repeated local midnight or a skipped one at a DST
 * transition — so regenerating the list in SQL risks a second, disagreeing
 * answer. Filling from `days` makes `daily.length === days.length` true by
 * construction, which is exactly what the drawer's bar count depends on. A
 * date-span is never derived by division: a day is 23, 24 or 25 hours of real
 * time depending on the zone.
 *
 * `by_model` merges on `(provider, model)` exactly like `queryModels`, so the
 * same upstream model under a built-in and a custom provider key is one row
 * with summed tokens. `display_name` is MAX-aggregated rather than grouped on:
 * grouping by it would re-split same-named models by their (possibly
 * different) labels. `pct` is a share of THIS member's tokens, and is 0 — not
 * NaN — when they used nothing.
 *
 * `unaccounted_calls` is scoped to this member, unlike the org-wide figure on
 * the list, which is what the drawer's gap notice is about.
 *
 * `user` is null when the id is not a member of this org. That is a real
 * reachable state (a cross-org id in a URL), and answering it with a fabricated
 * zeroed profile would render a drawer for a person who does not exist here.
 */
export interface UserDetailQuery {
  orgId: string;
  userId: string;
  from: Date;
  to: Date;
  timezone: string;
  days: string[];
}

export async function queryUserDetail(args: UserDetailQuery): Promise<UserDetailResult> {
  const params = [args.orgId, args.userId, args.from, args.to];

  const [userResult, dailyResult, byModelResult, missingResult] = await Promise.all([
    pool.query<{ user_id: string; display_name: string | null; department_name: string | null }>(
      DETAIL_USER_QUERY,
      [args.orgId, args.userId],
    ),
    pool.query<{ day: string; tokens: string | null }>(DETAIL_DAILY_QUERY, [...params, args.timezone]),
    pool.query<{ provider: string | null; model: string | null; display_name: string | null; tokens: string | null }>(
      DETAIL_BY_MODEL_QUERY,
      params,
    ),
    pool.query<{ missing_total: string }>(DETAIL_MISSING_QUERY, params),
  ]);

  const userRow = userResult.rows[0];

  const tokensByDay = new Map<string, number>();
  for (const row of dailyResult.rows) tokensByDay.set(row.day, Number(row.tokens ?? 0));
  const daily: UserDailyPoint[] = args.days.map((date) => ({
    date,
    tokens: tokensByDay.get(date) ?? 0,
  }));

  const merged = byModelResult.rows.map((row) => ({
    provider: row.provider ?? '',
    model: row.model ?? '',
    display_name: row.display_name ?? row.model ?? '',
    tokens: Number(row.tokens ?? 0),
  }));
  const total = merged.reduce((sum, row) => sum + row.tokens, 0);
  const by_model: UserModelShare[] = merged.map((row) => ({
    ...row,
    pct: total === 0 ? 0 : Math.round((row.tokens / total) * 1000) / 10,
  }));

  return {
    user: userRow
      ? {
          user_id: userRow.user_id,
          display_name: userRow.display_name,
          department_name: userRow.department_name,
        }
      : null,
    daily,
    by_model,
    unaccounted_calls: Number(missingResult.rows[0]?.missing_total ?? 0),
  };
}
