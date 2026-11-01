import { formatInTimeZone } from 'date-fns-tz';

import { pool } from '../db/pool';
import { timezone } from '../org/timezone';

export const UsageRange = {
  Today: 'today',
  Last7Days: '7d',
  Last30Days: '30d',
  ThisMonth: 'this_month',
  LastMonth: 'last_month',
} as const;
export type UsageRange = (typeof UsageRange)[keyof typeof UsageRange];

export const AuditRange = { ...UsageRange, Custom: 'custom' } as const;
export type AuditRange = (typeof AuditRange)[keyof typeof AuditRange];

/**
 * Chinese labels for the range keys, resolved server-side: the client only
 * ever sends the key, so a CSV's `统计范围：` line cannot ask it what the
 * window is called.
 *
 * Lives here rather than in either route because BOTH exports print it and the
 * audit page's range picker reads the same five names — a second copy in the
 * audit route would be free to drift and the two files' first lines would stop
 * agreeing on what 「近 7 天」 means. The typed `Record<UsageRange, string>`
 * makes a new key a compile error rather than an `undefined` leaking into the
 * first line of an archived file.
 */
export const RANGE_LABELS: Record<UsageRange, string> = {
  [UsageRange.Today]: '今天',
  [UsageRange.Last7Days]: '近 7 天',
  [UsageRange.Last30Days]: '近 30 天',
  [UsageRange.ThisMonth]: '本月',
  [UsageRange.LastMonth]: '上月',
};

export interface ResolvedRange {
  from: Date;
  to: Date;
  timezone: string;
  key: AuditRange;
  days: string[];
}

const MS_PER_DAY = 86400000;
const DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const USAGE_RANGE_KEYS: ReadonlySet<string> = new Set(Object.values(UsageRange));

/**
 * A UTC-midnight Date used purely as a zone-less arithmetic carrier for a
 * 'YYYY-MM-DD'. Every read and write goes through getUTC*, so the host's own
 * timezone and its DST transitions can never shift the result.
 *
 * date-fns' addDays/startOfMonth are deliberately avoided here: they read and
 * write *local* fields, so on a host that observes DST they would return
 * 23:00/01:00 anchors instead of midnight and silently move a day boundary.
 */
function anchor(day: string): Date {
  const [y, m, d] = day.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d));
}

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

function toDay(anchorDate: Date): string {
  return `${anchorDate.getUTCFullYear()}-${pad2(anchorDate.getUTCMonth() + 1)}-${pad2(anchorDate.getUTCDate())}`;
}

/** Day arithmetic on the zone-less `YYYY-MM-DD` carriers described above.
 *
 *  Exported because the dashboard's previous-window resolver has to shift the
 *  same day keys this module does, and a second copy of `addDays` is a second
 *  place for a DST-era off-by-one to hide. */
export function addDays(day: string, n: number): string {
  return toDay(new Date(anchor(day).getTime() + n * MS_PER_DAY));
}

/** The first day of `day`'s month. Exported for the same reason as `addDays`. */
export function monthStart(day: string): string {
  const a = anchor(day);
  return `${a.getUTCFullYear()}-${pad2(a.getUTCMonth() + 1)}-01`;
}

export function addMonths(day: string, n: number): string {
  const a = anchor(day);
  return toDay(new Date(Date.UTC(a.getUTCFullYear(), a.getUTCMonth() + n, 1)));
}

/**
 * The local 'YYYY-MM-DD' that `instant` falls on in `zone`.
 *
 * Intl is the only authority here: it is the same data date-fns-tz reads, so a
 * disagreement between the two would be a bug rather than a modelling choice.
 */
function localDay(instant: Date, zone: string): string {
  return formatInTimeZone(instant, zone, 'yyyy-MM-dd');
}

/**
 * The first instant whose local date in `zone` is `day`.
 *
 * Local midnight is almost always the answer, and fromZonedTime finds it, but two
 * DST shapes break the naive "resolve local midnight" rule. Both are real org
 * timezones rather than curiosities:
 *
 *  - Spring forward at 00:00 (Africa/Cairo, America/Havana, America/Santiago,
 *    Asia/Beirut, Atlantic/Azores): local midnight does not exist, and
 *    fromZonedTime resolves the gap to an instant that still reads as the
 *    PREVIOUS local day.
 *  - Fall back at 00:00 (Havana again, on its November date): local midnight
 *    happens TWICE and fromZonedTime returns the second one, leaving the day an
 *    hour short at its start.
 *
 * Either way the result contradicts the `days` list built from those same day
 * strings, which is precisely the page-vs-export skew this module exists to
 * prevent.
 *
 * So rather than trusting a single conversion, binary-search for the true
 * boundary: the smallest instant whose local date is >= day.
 *
 * That predicate is monotone for every ordinary transition — time never runs
 * backwards — EXCEPT at a backward local-date transition: an offset jump of an
 * hour or more that crosses midnight, moving the local date to an EARLIER day
 * and so making `localDay(x) >= day` false again for an instant it was already
 * true at. These are not rare curiosities: a `zdump` sweep of all 418 IANA
 * zones over 1850–2050 finds 76 backward local-date transitions across 15
 * zones, with jumps of 1h, 2h and 3h. Antarctica/Casey 2010-03-05 is the 3h
 * case; America/Goose_Bay 1988-10-30 is a 2h one (-02:00 -> -04:00, so the
 * date reads 10-30, 10-29, 10-30 within two hours) and America/St_Johns is an
 * alias carrying the same transition, not a third instance of it.
 *
 * At such an instant the search converges on the SECOND occurrence, making
 * `from` up to three hours late — bounded by the size of the jump. The
 * consequence is still bounded: `localDay(from)` keeps equalling the requested
 * day, so the declared `days` list never disagrees with the interval and no
 * query bucketed by `ts AT TIME ZONE` miscounts. No such instant is reachable
 * from any preset range; a request can only name one via an explicit `custom`
 * range. And none is reachable today at all: `orgs.timezone` is always 'UTC'
 * and has no setter this release, so the zone argument is a constant. Left
 * as-is deliberately — the alternative would be a much costlier exact search
 * for a case that cannot corrupt the day list. Whoever adds the org timezone
 * setting inherits this, and inherits the reason it is acceptable.
 *
 * The +/- 2 day bracket covers the full UTC offset range (-12..+14). If a zone
 * skipped the whole day (a midnight dateline jump), the search lands on the
 * transition into the next day, which still keeps `from <= to` and the interval
 * sane.
 */
function instantAtStartOfDay(day: string, zone: string): Date {
  const [y, m, d] = day.split('-').map(Number);
  const noonUTC = Date.UTC(y, m - 1, d, 12, 0, 0);

  let lo = noonUTC - 2 * MS_PER_DAY; // strictly before the day in any zone
  let hi = noonUTC;                  // at or after the day in any zone
  while (lo < hi) {
    const mid = lo + Math.floor((hi - lo) / 2);
    if (localDay(new Date(mid), zone) < day) lo = mid + 1;
    else hi = mid;
  }
  return new Date(lo);
}

/** Every 'YYYY-MM-DD' the half-open [fromDay, toDayExclusive) covers, in order. */
function daysBetween(fromDay: string, toDayExclusive: string): string[] {
  const days: string[] = [];
  // Both bounds are well-formed ISO day strings, which compare chronologically, so
  // the loop terminates on the first false test. If the bounds are inverted it never
  // runs and yields [].
  for (let d = fromDay; d < toDayExclusive; d = addDays(d, 1)) days.push(d);
  return days;
}

/**
 * `orgs.timezone` is free text and nothing validates it on write, so it may be
 * unparsable. Falling back to UTC keeps a bad value from turning every
 * analytics request into a 500.
 */
function safeZone(raw: string | null): string {
  try {
    return timezone.resolveZone(raw ?? 'UTC');
  } catch {
    return 'UTC';
  }
}

async function orgZone(orgId: string): Promise<string> {
  const r = await pool.query<{ timezone: string | null }>(
    `SELECT timezone FROM orgs WHERE id = $1`,
    [orgId]
  );
  if (r.rowCount === 0) throw new Error(`org not found: ${orgId}`);
  return safeZone(r.rows[0].timezone);
}

function assemble(key: AuditRange, fromDay: string, toDayExclusive: string, zone: string): ResolvedRange {
  return {
    from: instantAtStartOfDay(fromDay, zone),
    to: instantAtStartOfDay(toDayExclusive, zone),
    timezone: zone,
    key,
    days: daysBetween(fromDay, toDayExclusive),
  };
}

/** Named ranges, expressed as a half-open pair of day keys in the org zone. */
function boundsFor(key: UsageRange, today: string): { fromDay: string; toDayExclusive: string } {
  switch (key) {
    case UsageRange.Today:
      return { fromDay: today, toDayExclusive: addDays(today, 1) };
    case UsageRange.Last7Days:
      return { fromDay: addDays(today, -6), toDayExclusive: addDays(today, 1) };
    case UsageRange.Last30Days:
      return { fromDay: addDays(today, -29), toDayExclusive: addDays(today, 1) };
    case UsageRange.ThisMonth: {
      const start = monthStart(today);
      return { fromDay: start, toDayExclusive: monthStart(addMonths(start, 1)) };
    }
    case UsageRange.LastMonth: {
      const start = monthStart(today);
      return { fromDay: monthStart(addMonths(start, -1)), toDayExclusive: start };
    }
  }
}

async function resolvePreset(orgId: string, key: UsageRange): Promise<ResolvedRange> {
  const zone = await orgZone(orgId);
  const today = formatInTimeZone(new Date(), zone, 'yyyy-MM-dd');
  const { fromDay, toDayExclusive } = boundsFor(key, today);
  return assemble(key, fromDay, toDayExclusive, zone);
}

/**
 * Reject anything that is not a real calendar day.
 *
 * Shape alone is not enough: '2026-02-30' and '2026-13-01' match the pattern but
 * roll over silently, which would drop a day from `days` and shift the interval.
 * Round-tripping through `anchor` catches those, and every low-year case at once:
 * 0001-0099 hit JS's two-digit-year remap in Date.UTC ('0050-06-01' becomes 1950),
 * and 0100-0999 are rejected because `toDay` does not zero-pad the year, so they
 * re-render as '100-01-01'. Four-digit years from 1000 on are unaffected.
 *
 * ('9999-12-31' is a real day, so it passes here and is rejected separately at the
 * call site, where the exclusive bound would overflow.)
 */
function assertDay(value: string, label: string): void {
  if (!DAY_PATTERN.test(value)) throw new Error(`invalid ${label} date: ${value}`);
  if (toDay(anchor(value)) !== value) {
    throw new Error(`invalid ${label} date: ${value}`);
  }
}

export async function resolveUsageRange(orgId: string, range: UsageRange): Promise<ResolvedRange> {
  if (!USAGE_RANGE_KEYS.has(range)) throw new Error(`unknown usage range: ${range}`);
  return resolvePreset(orgId, range);
}

/**
 * The window immediately BEFORE the one `resolveUsageRange` returns, for the
 * dashboard's period-over-period figures.
 *
 * Two families, and the split is load-bearing:
 *
 *  - Day ranges (`today`, `7d`, `30d`) shift back by their own length. "近 7 天"
 *    compares against the seven days before it, which is what an admin means.
 *  - Month ranges CANNOT do that. Shifting 2026-03-01 back by March's 31 days
 *    lands on 2026-01-29 — the window straddles two months, so "上月 vs 上上月"
 *    silently becomes a cross-month comparison. They anchor on the previous
 *    month's 1st instead, which is what spec §5.2 names (本月 → 上月同期,
 *    上月 → 上上月同期).
 *
 * `today` additionally clips its right edge to the current wall clock. The
 * current window runs to tomorrow midnight (see `boundsFor`), but only the
 * elapsed part of it has data; comparing that against a whole "yesterday"
 * reports a delta that is an artefact of the clock, not of usage.
 *
 * The CURRENT window is deliberately not clipped: `resolveUsageRange` is the
 * single definition of which rows a range covers, and the dashboard must scan
 * exactly the rows the usage page scans. Clipping lives here, on the comparison
 * side only, where no row-selection decision depends on it.
 */
export async function resolvePreviousUsageRange(
  orgId: string,
  range: UsageRange
): Promise<ResolvedRange> {
  if (!USAGE_RANGE_KEYS.has(range)) throw new Error(`unknown usage range: ${range}`);
  const zone = await orgZone(orgId);
  const today = formatInTimeZone(new Date(), zone, 'yyyy-MM-dd');
  const { fromDay, toDayExclusive } = boundsFor(range, today);
  const len = daysBetween(fromDay, toDayExclusive).length;

  if (range === UsageRange.ThisMonth || range === UsageRange.LastMonth) {
    const prevStart = monthStart(addMonths(fromDay, -1));
    const prevEnd = range === UsageRange.ThisMonth ? addDays(prevStart, len) : fromDay;
    return assemble(range, prevStart, prevEnd, zone);
  }

  if (range === UsageRange.Today) {
    const base = assemble(range, addDays(today, -1), today, zone);
    const now = new Date();
    const hour = Number(formatInTimeZone(now, zone, 'H'));
    const minute = Number(formatInTimeZone(now, zone, 'm'));
    return { ...base, to: new Date(base.from.getTime() + (hour * 60 + minute) * 60000) };
  }

  return assemble(range, addDays(fromDay, -len), fromDay, zone);
}

/**
 * `custom` names both endpoints as days the user picked and is inclusive of
 * each, so the exclusive upper bound is the day after `to`.
 */
export async function resolveAuditRange(
  orgId: string,
  range: AuditRange,
  custom?: { from?: string; to?: string }
): Promise<ResolvedRange> {
  if (range === AuditRange.Custom) {
    const from = custom?.from;
    const to = custom?.to;
    if (!from || !to) throw new Error('custom range requires both from and to');
    assertDay(from, 'from');
    assertDay(to, 'to');
    // The exclusive bound is `to` + 1 day; at 9999-12-31 that overflows to a
    // 5-digit year which would break the ISO comparison in daysBetween and
    // silently yield an empty day list.
    if (to === '9999-12-31') throw new Error('invalid to date: 9999-12-31');
    if (from > to) throw new Error('custom range requires from <= to');
    const zone = await orgZone(orgId);
    return assemble(AuditRange.Custom, from, addDays(to, 1), zone);
  }
  if (!USAGE_RANGE_KEYS.has(range)) throw new Error(`unknown audit range: ${range}`);
  return resolvePreset(orgId, range);
}
