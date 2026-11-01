import { formatInTimeZone } from 'date-fns-tz';
import { type Context, Hono } from 'hono';

import { type AuditListFilters,type AuditListItem,queryAudit } from '../../analytics/auditQuery';
import { csvResponse, toCsv } from '../../analytics/csv';
import { AuditRange, RANGE_LABELS, resolveAuditRange, type ResolvedRange } from '../../analytics/range';
import { requireAuth, requirePermission } from '../../auth/middleware';
import { PermissionPoint as PP } from '../../shared/permissionPoints';

const AUDIT_RANGE_VALUES: ReadonlySet<string> = new Set(Object.values(AuditRange));

export const adminAuditRoutes = new Hono();

/**
 * Two path-level guards, most specific first, and the order is load-bearing.
 * Hono matches middleware in registration order, so a single
 * `use('/admin/audit/*', …audit:view…)` declared ahead of the export route
 * would evaluate `/admin/audit/export.csv` against `audit:view` and refuse
 * callers who legitimately hold only `audit:export`. The export below carries
 * its own `requirePermission(PP.AuditExport)`, which is why the path is claimed
 * here first.
 *
 * `requireAuth` rather than `requirePermission` on both: the permission gate
 * lives on each route handler, mirroring `routes/admin/usage.ts`, and
 * `requirePermission` re-verifies the token itself anyway.
 *
 * Note that `/admin/audit/*` matches `/admin/audit/export.csv` on its own
 * (verified against the installed Hono 4.13.13: `*` matches any suffix
 * including a non-empty one). The specific line above is therefore not what
 * keeps the export out of the catch-all's way today — both are `requireAuth`,
 * so running twice is harmless. It is kept because the claim is the
 * load-bearing idea, and because the moment the catch-all stops being a plain
 * auth check, only the specific line still protects the export's own gate.
 */
adminAuditRoutes.use('/admin/audit/export.csv', requireAuth);
adminAuditRoutes.use('/admin/audit/*', requireAuth);

/** A trimmed query value, with the empty string treated as absent — an empty
 * `?action=` left behind by a cleared filter box must not filter on the empty
 * string and hide the whole table. */
function queryFilter(raw: string | undefined): string | undefined {
  const value = raw?.trim();
  return value ? value : undefined;
}

/** `?exclude=a,b,c` → `['a','b','c']`.
 *
 * Comma-separated rather than repeated because that is what a URL can carry in
 * one place, and it is the spelling the page sends. De-duplicated because
 * `?exclude=provider_call,provider_call` is the same request as one code and
 * there is no reason for it to bind a longer array; empty entries are dropped
 * rather than becoming a predicate that can never match, so `?exclude=,` is the
 * no-exclusion request rather than a request that hides everything. */
function queryExclude(raw: string | undefined): string[] {
  const value = queryFilter(raw);
  if (!value) return [];
  return [...new Set(value.split(',').map((code) => code.trim()).filter((code) => code.length > 0))];
}

/**
 * Rows rendered per export.
 *
 * This IS a cap, and past it the file is SHORT: the export renders page 1 of
 * the query and stops, so a window holding more than this many events yields a
 * file with `EXPORT_PAGE_SIZE` rows rather than all of them. That is a
 * deliberate trade — refusing to export past the cap would make the feature
 * unavailable to exactly the largest orgs, which is the wrong failure for a
 * merely-large query — but it is only a safe trade if the caller can SEE it.
 * Hence the two headers on the response: `x-export-count` is what this file
 * holds, `x-export-total` is what the query matched, and for any window over
 * the cap they differ. See `csvResponse`.
 *
 * 10,000 is sized against the result one request can materialise, and well past
 * the table's own 200 — which is exactly why the export does not share
 * `paging()`: inheriting that cap would truncate a busy org's month at 200 rows
 * while reporting a `total` in the tens of thousands.
 *
 * Exported so the truncation tests size their fixture off the real number
 * rather than a copy of it that would silently stop exercising the cap.
 */
export const EXPORT_PAGE_SIZE = 10_000;

/**
 * A payload rendered for one cell.
 *
 * `null`/undefined become an empty cell rather than the four letters `null`:
 * an event with no payload has nothing to say, and `JSON.stringify(null)` would
 * print a string that a reader could mistake for a payload saying "null".
 * Everything else is JSON text, which `toCsv` then escapes per RFC 4180.
 */
function jsonCell(item: AuditListItem): string {
  return item.payload === null || item.payload === undefined
    ? ''
    : JSON.stringify(item.payload);
}

/** Page 1 of 15 by default (spec §5.3). `page` is bounded because an absurd
 * offset is refused by Postgres with 22P02 (invalid_text_representation)
 * rather than clamped, which would turn a typo in the URL into a 500. */
function paging(page: string | undefined, pageSize: string | undefined): { page: number; pageSize: number } {
  const requestedPage = Number(page ?? '1') || 1;
  const requestedPageSize = Number(pageSize ?? '15') || 15;
  return {
    page: Math.min(1_000_000, Math.max(1, Math.floor(requestedPage))),
    pageSize: Math.min(200, Math.max(1, Math.floor(requestedPageSize))),
  };
}

/** The six columns of spec §5.4 / §6.3, in the order the audit page shows
 * them. 操作 is the Chinese label (`action_zh`), not the code: a file that
 * says `user_disable` is only readable by someone who already knows the code
 * book. */
const AUDIT_CSV_HEADER = ['时间', '用户', '操作', '对象类型', '对象ID', '载荷'];

/** Where the table shows an em dash for "none". A blank cell in a spreadsheet
 * reads as "the export lost this" rather than "there is nothing here". */
const NONE = '—';

/** `custom` is the one range with no fixed name — the window is whatever days
 * the caller picked. Naming it 「自定义」 alone would tell an auditor reading
 * the file six months later nothing at all, so the resolved day list is spelled
 * out. Read off `ResolvedRange.days`, which the resolver already built, rather
 * than off the raw query parameters the user typed. */
const CUSTOM_LABEL = '自定义';

function rangeLabel(resolved: ResolvedRange): string {
  if (resolved.key !== AuditRange.Custom) return RANGE_LABELS[resolved.key];
  const first = resolved.days[0];
  const last = resolved.days[resolved.days.length - 1];
  return first && last ? `${CUSTOM_LABEL} ${first} 至 ${last}` : CUSTOM_LABEL;
}

/** The five list filters, read exactly as `GET /admin/audit` reads them, so a
 * filtered table and its export describe the same slice of the org's history.
 *
 * `exclude` is read here and not alongside the other four because it has to
 * reach BOTH routes: it is the one filter that can make the file and the table
 * disagree about how much history there is, so it is forwarded by construction
 * rather than remembered in the browser. A caller that filters the rows out
 * after fetching would produce an export containing rows the page never showed,
 * which is precisely the disagreement this module refuses to permit. */
function listFilters(c: Context): AuditListFilters {
  return {
    userId: queryFilter(c.req.query('userId')),
    action: queryFilter(c.req.query('action')),
    targetType: queryFilter(c.req.query('targetType')),
    targetId: queryFilter(c.req.query('targetId')),
    exclude: queryExclude(c.req.query('exclude')),
  };
}

/**
 * `requirePermission(PP.AuditExport)`, NOT `AuditView`.
 *
 * Reading a number on screen and walking away with the whole set are different
 * permissions: an auditor scoped to the page has no reason to hold the
 * bulk-extraction one. Mirrors `/admin/usage/export.csv`.
 *
 * MOUNT ORDER IS LOAD-BEARING. Hono matches in registration order, so this
 * route must be declared before any `/admin/audit/*` middleware carrying
 * `AuditView`. The behavioural probe in auditExport.test.ts — a role holding
 * ONLY `audit:export`, which gets 200 here and 403 on the list — is the only
 * assertion that can see a mis-ordering, because a wrongly-ordered mount still
 * returns a plausible 403 for every other caller in the suite.
 *
 * The rows come from `queryAudit` itself, with `page: 1` and a page size well
 * past anything the table would serve. Reusing the table's own query is the
 * point: a second SQL statement here could gain a predicate or lose the
 * login_events union and the file would quietly disagree with the page, which is
 * the one failure this whole module exists to prevent. `pageSize` is the export's
 * own parameter, not the table's clamped one — the route's `paging()` caps at
 * 200, and inheriting that would truncate a busy org's month at 200 rows while
 * reporting a `total` of 12,000.
 *
 * What that buys instead of truncation-by-inheritance is a cap ten times
 * further out, plus an honest account of having hit it: `x-export-count` is
 * this file's row count and `x-export-total` is the query's, so a client can
 * tell a capped file from a complete one. See EXPORT_PAGE_SIZE.
 *
 * `?exclude=` is forwarded from the same `listFilters` the list route reads, so
 * a file taken with model calls hidden holds exactly the rows the page was
 * showing — and `x-excluded-count` says how many were left out, because the
 * person opening the file has not seen the filter that removed them.
 */
adminAuditRoutes.get('/admin/audit/export.csv', requirePermission(PP.AuditExport), async (c) => {
  const claims = c.get('claims');

  const rawRange = c.req.query('range') ?? AuditRange.Last30Days;
  if (!AUDIT_RANGE_VALUES.has(rawRange)) return c.json({ error: 'invalid_range' }, 400);
  const range = rawRange as AuditRange;

  // Same resolver call as the list, so the file's window is the window the page
  // claims — in the org's own zone, day boundaries included.
  let resolved;
  try {
    resolved = await resolveAuditRange(claims.orgId, range, {
      from: queryFilter(c.req.query('from')),
      to: queryFilter(c.req.query('to')),
    });
  } catch {
    return c.json({ error: 'invalid_range' }, 400);
  }

  const result = await queryAudit({
    orgId: claims.orgId,
    from: resolved.from,
    to: resolved.to,
    filters: listFilters(c),
    // Hard-coded true, exactly as the list: a failed sign-in writes no
    // `audit_events` row at all, so the union is what makes it visible.
    includeLogin: true,
    page: 1,
    pageSize: EXPORT_PAGE_SIZE,
  });

  const rows = result.items.map((item) => [
    // Spec §5.4's AUDIT time shape (`YYYY/MM/DD HH:mm:ss`) — NOT the usage
    // export's `MM/dd HH:mm` — rendered in the org's zone. A raw ISO instant
    // would drag a `Z` into a column someone reads by eye and would disagree
    // with a window the resolver built in local time. `resolveAuditRange` has
    // already validated the zone.
    formatInTimeZone(new Date(item.ts), resolved.timezone, 'yyyy/MM/dd HH:mm:ss'),
    item.user_name ?? NONE,
    item.action_zh,
    item.target_type_zh ?? NONE,
    item.target_id ?? NONE,
    // `toCsv` runs every cell through `csvCell`, so a JSON body full of commas
    // and quotes stays in one column. The legacy export escaped commas with
    // `.replace(/,/g,'\,')`, which DELETED them rather than quoting the field,
    // so any payload with a comma spilled into the next column.
    jsonCell(item),
  ]);

  const body = toCsv({ rangeLabel: rangeLabel(resolved) }, AUDIT_CSV_HEADER, rows);
  // The FILENAME carries the range KEY, not the Chinese label (spec §5.4). The
  // key is ASCII, so the range portion survives content-disposition without
  // percent-encoding — `近 7 天-审计记录.csv` encodes to 66 characters against 43
  // for `7d-审计记录.csv`, and the space becomes `%20`. The label belongs in the
  // file's first line and in the UI's toast, which is what `rangeLabel` is for.
  return csvResponse({
    body,
    // `total` is what the query matched; `rowCount` is what this file holds.
    // Equal for every window that fits under EXPORT_PAGE_SIZE, different for
    // the ones that do not — which is the only thing making that truncation
    // visible to the client instead of silent.
    rowCount: rows.length,
    total: result.total,
    // Not a free extra: the file is opened by people who never saw the page, so
    // without this header a file that omits every model call reads as a
    // complete record of the window. It is `0` for the overwhelming majority of
    // exports and is never allowed to be absent.
    excluded: result.excluded,
    filename: `${range}-审计记录.csv`,
  });
});

/**
 *   GET /admin/audit?range=30d&from=&to=&userId=&action=&targetType=&targetId=&exclude=&page=1&pageSize=15
 *
 * `exclude` is a comma-separated list of action codes to DROP, and it is the
 * only filter here that removes rows rather than selecting them. It exists
 * because the proxy writes a `provider_call` row for every model request and
 * the gateway streams essentially all enterprise traffic: without it the page
 * opens on a wall of 「调用模型服务商」 and the sign-in failures and key
 * revocations an admin came for are somewhere below the fold.
 *
 * Three properties make it usable rather than merely quieter:
 *  - it applies to `items`, `total` AND the row count the CSV sees, so the
 *    table and its export can never disagree about what was left out;
 *  - it does NOT apply to the `actions` facet, so an excluded code is still
 *    offered in the dropdown and can be put back — the exclusion is a switch,
 *    not a one-way door;
 *  - `excluded` reports how many matched-but-hidden rows the request found, so
 *    a caller can disclose the filter instead of applying it silently.
 *
 * There is no server-side default: with no `exclude`, every action is returned.
 * Choosing what to hide by default is the page's editorial call, not the API's,
 * and baking it in here would make the export silently drop rows for anyone
 * calling this endpoint directly.
 *
 * `includeLogin` is hard-coded true: the audit page is where an admin looks
 * when a sign-in misbehaves, and a failed attempt writes no `audit_events` row
 * at all, so leaving `login_events` out hides precisely the rows that matter.
 * (There is no query parameter to toggle it — `web/src/api/audit.ts` sends none
 * and the union is unconditional. The legacy `?include=login` spelling once did,
 * and is accepted and ignored.)
 *
 * The org comes from the JWT claims only. There is deliberately no `orgId`
 * parameter to honour: accepting one would let any authenticated member read
 * another org's audit trail by editing a URL.
 *
 * `range=custom` is the one place a user-supplied date reaches the resolver,
 * so its `throw` (an unparsable or inverted `from`/`to`) becomes a 400 here
 * instead of a 500.
 */
adminAuditRoutes.get('/admin/audit', requirePermission(PP.AuditView), async (c) => {
  const claims = c.get('claims');

  const rawRange = c.req.query('range') ?? AuditRange.Last30Days;
  if (!AUDIT_RANGE_VALUES.has(rawRange)) return c.json({ error: 'invalid_range' }, 400);
  const range = rawRange as AuditRange;

  let resolved;
  try {
    resolved = await resolveAuditRange(claims.orgId, range, {
      from: queryFilter(c.req.query('from')),
      to: queryFilter(c.req.query('to')),
    });
  } catch {
    return c.json({ error: 'invalid_range' }, 400);
  }

  const filters = listFilters(c);

  const { page, pageSize } = paging(c.req.query('page'), c.req.query('pageSize'));
  const result = await queryAudit({
    orgId: claims.orgId,
    from: resolved.from,
    to: resolved.to,
    filters,
    includeLogin: true,
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
    // Matched but hidden. The page renders this rather than dropping the
    // filter silently, which is the whole reason the count exists.
    excluded: result.excluded,
    items: result.items,
    facets: result.facets,
  });
});