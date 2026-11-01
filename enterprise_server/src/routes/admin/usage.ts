import { formatInTimeZone } from 'date-fns-tz';
import { type Context, Hono } from 'hono';

import { csvResponse, toCsv } from '../../analytics/csv';
import { RANGE_LABELS, resolveUsageRange, UsageRange } from '../../analytics/range';
import {
  queryModels,
  queryModelsAll,
  queryUserDetail,
  queryUsers,
  queryUsersAll,
  type UsageModelsResult,
  UsageUserSort,
} from '../../analytics/usage';
import { requireAuth, requirePermission } from '../../auth/middleware';
import { PermissionPoint as PP } from '../../shared/permissionPoints';

const USAGE_RANGE_VALUES: ReadonlySet<string> = new Set(Object.values(UsageRange));

/**
 * Admin-facing usage analytics.
 *
 *   GET /admin/usage/export.csv?range=&tab=models|users
 *   GET /admin/usage/models?range=7d&page=1&pageSize=50
 *   GET /admin/usage/users?range=7d&q=&sort=desc&page=1&pageSize=8
 *   GET /admin/usage/users/:userId?range=7d
 *
 * `users` is the full roster (D6) — `users` is the LEFT table, so zero-usage
 * and disabled members both appear; see `queryUsers`. The detail route hands
 * `resolveUsageRange`'s own `timezone` and `days` straight through, so the
 * drawer's bar count is the resolver's day list and not a second guess at it.
 *
 * Returns one row per `(provider, model)` pair: same-named models under a
 * built-in provider key and a custom provider key (migration 039) merge
 * into one row with summed tokens. Catalog rows with no calls in range
 * still surface at zero. Hard-deleted catalog rows do not produce usage
 * orphans in this schema — see the usage-side LEFT JOIN note in
 * `src/analytics/usage.ts`.
 *
 * Auth: requireAuth first (defense in depth), then the permission-point
 * gate per route. requirePermission resolves `usage:view` via Postgres
 * `roles.permissions`, which migration 052 stamped onto the builtin
 * `super_admin`, `org_admin`, and `auditor` roles.
 *
 * Every route takes its org from the JWT claims, never from a query
 * parameter — `?orgId=` is ignored, because honouring it would let any
 * authenticated member read another org's usage by editing a URL.
 */
export const adminUsageRoutes = new Hono();
adminUsageRoutes.use('/admin/usage/*', requireAuth);

const MODEL_CSV_HEADER = ['模型提供商', '模型名称', '模型用量(tokens)', '调用次数'];
const USER_CSV_HEADER = ['用户名称', '部门', '用量', '最近使用时间'];

/** Rendered where the table shows an em dash for "never". A blank cell would
 * read as a missing value rather than a known-zero one. */
const NEVER = '—';

const EXPORT_TABS = { Models: 'models', Users: 'users' } as const;
type ExportTab = (typeof EXPORT_TABS)[keyof typeof EXPORT_TABS];
const EXPORT_TAB_VALUES: ReadonlySet<string> = new Set(Object.values(EXPORT_TABS));

const USER_SORT_VALUES: ReadonlySet<string> = new Set(Object.values(UsageUserSort));

/**
 *   GET /admin/usage/export.csv?range=7d&tab=models|users
 *
 * Gated on `usage:export`, not `usage:view`. Being able to read a number on
 * screen and being able to walk away with the full set are different
 * permissions — an auditor scoped to the dashboard has no reason to hold the
 * bulk-extraction one — so this route carries its own gate.
 *
 * MOUNT ORDER IS LOAD-BEARING. Hono matches middleware in registration
 * order, so this must be declared before any `/admin/usage/*` middleware
 * that carries `UsageView`; one registered ahead of this route would gate
 * the export with the wrong point and refuse callers who legitimately hold
 * `usage:export`. The behavioral test in usageExport.test.ts (view-only role
 * → 403 here, 200 on the table) is what catches a regression here, since a
 * wrongly-ordered mount still returns a plausible 403.
 *
 * The body comes from `queryModelsAll`/`queryUsersAll` — the table's own SQL
 * with the window dropped — so the exported row count equals the table's
 * `total` by construction. Passing a large `pageSize` to `queryModels`
 * instead would inherit the route's clamping and could silently truncate.
 */
adminUsageRoutes.get('/admin/usage/export.csv', requirePermission(PP.UsageExport), async (c) => {
  const claims = c.get('claims');

  const rawRange = c.req.query('range') ?? UsageRange.Last7Days;
  if (!USAGE_RANGE_VALUES.has(rawRange)) return c.json({ error: 'invalid_range' }, 400);
  const range = rawRange as UsageRange;

  const rawTab = c.req.query('tab') ?? EXPORT_TABS.Models;
  if (!EXPORT_TAB_VALUES.has(rawTab)) return c.json({ error: 'invalid_tab' }, 400);
  const tab = rawTab as ExportTab;

  const label = RANGE_LABELS[range];
  const resolved = await resolveUsageRange(claims.orgId, range);
  const window = { orgId: claims.orgId, from: resolved.from, to: resolved.to };

  if (tab === EXPORT_TABS.Models) {
    const rows = await queryModelsAll(window);
    const body = toCsv(
      { rangeLabel: label },
      MODEL_CSV_HEADER,
      rows.map((r) => [r.provider, r.model, r.total_tokens, r.call_count]),
    );
    // The FILENAME carries the range KEY, not the Chinese label (spec §5.4).
    // The key is ASCII, so the whole name survives content-disposition
    // without percent-encoding the range portion — `近 7 天-模型用量.csv`
    // encodes to 66 characters against 43 for `7d-模型用量.csv`, and the
    // space becomes `%20`. The Chinese label belongs in the file's first
    // line and in the UI's toast, which is what `rangeLabel` above is for.
    return csvResponse({ body, rowCount: rows.length, filename: `${range}-模型用量.csv` });
  }

  // `q`/`sort` are forwarded so the file matches what the admin is looking at.
  // A filtered table that exports the unfiltered company is its own version of
  // the page-vs-export disagreement.
  const rawSort = c.req.query('sort') ?? UsageUserSort.Desc;
  if (!USER_SORT_VALUES.has(rawSort)) return c.json({ error: 'invalid_sort' }, 400);
  const q = c.req.query('q')?.trim();
  const rows = await queryUsersAll({
    ...window,
    q: q ? q : undefined,
    sort: rawSort as UsageUserSort,
  });

  const body = toCsv(
    { rangeLabel: label },
    USER_CSV_HEADER,
    rows.map((r) => [
      r.display_name || r.username,
      r.department_name ?? '',
      r.total_tokens,
      // Rendered in the org's own zone (spec §5.4): `MM/DD HH:mm`, the same
      // shape the table shows. The window this file claims to cover was
      // resolved in that zone, so formatting in it is what keeps a row at the
      // range's edge from reading as a day the export says it excludes. A raw
      // ISO instant would also drag `Z` into a column finance staff read by
      // eye. `resolveUsageRange` already validated the zone.
      r.last_used_at ? formatInTimeZone(new Date(r.last_used_at), resolved.timezone, 'MM/dd HH:mm') : NEVER,
    ]),
  );
  return csvResponse({ body, rowCount: rows.length, filename: `${range}-用户用量.csv` });
});

adminUsageRoutes.get('/admin/usage/models', requirePermission(PP.UsageView), async (c) => {
  const claims = c.get('claims');

  const rawRange = c.req.query('range') ?? UsageRange.Last7Days;
  if (!USAGE_RANGE_VALUES.has(rawRange)) {
    return c.json({ error: 'invalid_range' }, 400);
  }
  const range = rawRange as UsageRange;

  // `page` is bounded: a 20-digit query value would OFFSET past
  // bigint's safe range and Postgres would refuse with 22P02
  // (invalid_text_representation). 1,000,000 covers every realistic
  // use and keeps the route from 500ing on crafted input.
  const requestedPage = Number(c.req.query('page') ?? '1') || 1;
  const page = Math.min(1_000_000, Math.max(1, Math.floor(requestedPage)));
  const requestedPageSize = Number(c.req.query('pageSize') ?? '50') || 50;
  const pageSize = Math.min(200, Math.max(1, requestedPageSize));

  // Dashboard deep link: `?model=<provider>/<model>` isolates one row. Split on
  // the FIRST slash only — an upstream model id can itself contain slashes
  // (`org/repo/model` style names are ordinary), so a lastIndexOf split would
  // truncate the provider and silently filter nothing.
  const rawModel = c.req.query('model');
  let model: { provider: string; model: string } | undefined;
  if (rawModel) {
    const slash = rawModel.indexOf('/');
    if (slash <= 0 || slash === rawModel.length - 1) {
      return c.json({ error: 'invalid_model' }, 400);
    }
    model = { provider: rawModel.slice(0, slash), model: rawModel.slice(slash + 1) };
  }

  const resolved = await resolveUsageRange(claims.orgId, range);
  const result: UsageModelsResult = await queryModels({
    orgId: claims.orgId,
    from: resolved.from,
    to: resolved.to,
    page,
    pageSize,
    model,
  });

  return c.json({
    range,
    from: resolved.from.toISOString(),
    to: resolved.to.toISOString(),
    timezone: resolved.timezone,
    page: result.page,
    pageSize: result.pageSize,
    total: result.total,
    items: result.items,
    unaccounted_calls: result.unaccounted_calls,
  });
});

/** `page`/`pageSize` parsing shared by the two new routes. `page` is bounded
 * for the same reason as on /models: a 20-digit value would OFFSET past
 * bigint's safe range and Postgres would refuse with 22P02. */
function paging(c: Context): { page: number; pageSize: number } {
  const requestedPage = Number(c.req.query('page') ?? '1') || 1;
  const requestedPageSize = Number(c.req.query('pageSize') ?? '8') || 8;
  return {
    page: Math.min(1_000_000, Math.max(1, Math.floor(requestedPage))),
    pageSize: Math.min(200, Math.max(1, Math.floor(requestedPageSize))),
  };
}

/**
 *   GET /admin/usage/users?range=7d&q=&sort=desc&page=1&pageSize=8
 *
 * The full roster (D6): `users` is the left table, so members with no calls
 * in range and disabled members are both listed. An admin asking "who used
 * nothing" wants the whole headcount, so nothing here filters on `status`.
 *
 * `sort` is validated against a closed set rather than passed to SQL.
 * `q` is escaped before it becomes an ILIKE pattern.
 */
adminUsageRoutes.get('/admin/usage/users', requirePermission(PP.UsageView), async (c) => {
  const claims = c.get('claims');

  const rawRange = c.req.query('range') ?? UsageRange.Last7Days;
  if (!USAGE_RANGE_VALUES.has(rawRange)) return c.json({ error: 'invalid_range' }, 400);
  const range = rawRange as UsageRange;

  const rawSort = c.req.query('sort') ?? UsageUserSort.Desc;
  if (!USER_SORT_VALUES.has(rawSort)) return c.json({ error: 'invalid_sort' }, 400);
  const sort = rawSort as UsageUserSort;

  const { page, pageSize } = paging(c);
  const q = c.req.query('q')?.trim();
  const resolved = await resolveUsageRange(claims.orgId, range);
  const result = await queryUsers({
    orgId: claims.orgId,
    from: resolved.from,
    to: resolved.to,
    q: q ? q : undefined,
    sort,
    page,
    pageSize,
  });

  return c.json({
    range,
    from: resolved.from.toISOString(),
    to: resolved.to.toISOString(),
    timezone: resolved.timezone,
    page: result.page,
    pageSize: result.pageSize,
    total: result.total,
    items: result.items,
    unaccounted_calls: result.unaccounted_calls,
  });
});

/**
 *   GET /admin/usage/users/:userId?range=7d
 *
 * The drawer's data. `timezone` and `days` come straight from
 * resolveUsageRange: the day list is the resolver's answer, and a second
 * source of truth for "which days does this range cover" is exactly the
 * disagreement this endpoint cannot afford.
 */
adminUsageRoutes.get('/admin/usage/users/:userId', requirePermission(PP.UsageView), async (c) => {
  const claims = c.get('claims');

  const rawRange = c.req.query('range') ?? UsageRange.Last7Days;
  if (!USAGE_RANGE_VALUES.has(rawRange)) return c.json({ error: 'invalid_range' }, 400);
  const range = rawRange as UsageRange;

  const resolved = await resolveUsageRange(claims.orgId, range);
  const result = await queryUserDetail({
    orgId: claims.orgId,
    userId: c.req.param('userId'),
    from: resolved.from,
    to: resolved.to,
    timezone: resolved.timezone,
    days: resolved.days,
  });

  // A member of another org is indistinguishable from one who does not exist,
  // and both answer 404 rather than leaking that the id is real elsewhere.
  if (!result.user) return c.json({ error: 'user_not_found' }, 404);

  return c.json({
    range,
    from: resolved.from.toISOString(),
    to: resolved.to.toISOString(),
    timezone: resolved.timezone,
    user: result.user,
    daily: result.daily,
    by_model: result.by_model,
    unaccounted_calls: result.unaccounted_calls,
  });
});
