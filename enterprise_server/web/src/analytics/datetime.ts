/**
 * Timestamp rendering for the analytics pages.
 *
 * Both the usage and the audit tables show an instant that the server already
 * placed in the ORG's zone: `resolveAuditRange` / `resolveUsageRange` compute
 * the window there, and `routes/admin/{usage,audit}.ts` write the same column
 * into the CSV with `formatInTimeZone(…, resolved.timezone, …)`. So the table
 * must render there too — a browser-zone table disagrees with the file it just
 * exported, and (worse for usage) can show a call on a different day than the
 * chart buckets it into.
 *
 * Every analytics surface formats through THIS module. The three callers it
 * grew up with were separate copies, and a fix applied to one (the NaN guard
 * below) was silently absent from the others — a copy-paste guard is not a
 * guard. One implementation, two shapes, exported below.
 */

import { getLang } from '../i18n';

/** What a cell shows when the value is not a renderable instant: absent,
 *  unparseable, or from a zone string `Intl` rejected. Matches the CSV's empty
 *  cell marker, so "never used" and "unrenderable" read as data rather than as
 *  a blank or a crash. */
const EMPTY_CELL = '—';

/**
 * The calendar fields of `date` as `Intl` reads them in `tz`.
 *
 * `formatToParts` rather than `format`: the whole-string shape of an `en-CA`
 * date varies by ICU build (the comma between date and time is not guaranteed),
 * but the individual fields are.
 *
 * Throws a `RangeError` when `tz` is a string `Intl` rejects — which is why
 * every caller goes through `formatInOrgZone` below rather than calling this
 * directly.
 */
function partsInZone(date: Date, tz: string | undefined): Record<string, string> {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    // h23, not the locale default: an h12 zone renders midnight as "24" in
    // some ICU versions, which would read as tomorrow's midnight.
    hourCycle: 'h23',
  })
    .formatToParts(date)
    .reduce<Record<string, string>>((acc, p) => ({ ...acc, [p.type]: p.value }), {});
}

/** Render an instant in the org's zone, or `—` when it cannot be rendered.
 *
 *  Both failure modes are guarded HERE rather than at the call sites, because
 *  both have to be:
 *
 *  - An unparseable `iso` makes every `Intl.DateTimeFormat` method throw
 *    (`RangeError: Invalid time value`). Without the NaN check that throw
 *    happens inside the `try`, the `catch` retries with `tz: undefined`, and
 *    it throws AGAIN — this time uncaught, out of a table cell's `render` and
 *    into a page-level crash. The check has to come before the `try`.
 *  - `timeZone` is best-effort by design: a hand-edited `orgs.timezone` can
 *    carry a string `Intl` rejects. One unusable zone must not take a table
 *    down, so it degrades to the browser zone — one column is wrong, the page
 *    still works.
 *
 *  `shape` receives the calendar fields and returns the cell text, so the two
 *  exported shapes below share every bit of this logic.
 */
function formatInOrgZone(
  iso: string | null | undefined,
  timeZone: string | undefined,
  shape: (f: Record<string, string>) => string
): string {
  if (!iso) return EMPTY_CELL;
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return EMPTY_CELL;
  try {
    return shape(partsInZone(date, timeZone));
  } catch {
    return shape(partsInZone(date, undefined));
  }
}

/** `YYYY/MM/DD HH:mm:ss` for an instant, rendered in the org's zone.
 *
 * This is the shape spec §6.3 names for the audit table AND the one
 * `routes/admin/audit.ts` writes with
 * `formatInTimeZone(…, 'yyyy/MM/dd HH:mm:ss')`, so a row on screen and the
 * same row in the exported file read identically.
 *
 * `Intl.DateTimeFormat` rather than dayjs: dayjs needs the `timezone` plugin
 * plus a zone string, and this app does not bundle one.
 */
export function formatOrgDateTime(iso: string | null | undefined, timeZone?: string): string {
  return formatInOrgZone(
    iso,
    timeZone,
    (f) => `${f.year}/${f.month}/${f.day} ${f.hour}:${f.minute}:${f.second}`
  );
}

/** `MM/DD HH:mm` for an instant, rendered in the org's zone — the usage
 *  members table's `last_used_at` column, and the shape
 *  `routes/admin/usage.ts` writes for the same column with
 *  `formatInTimeZone(…, resolved.timezone, 'MM/dd HH:mm')`.
 *
 *  Not the browser's. The server resolved the range in that zone too, so a
 *  browser-zone cell would show a member's last call hours away from the day
 *  the chart buckets it into, and would disagree with the file it just
 *  exported. That page-vs-export split is the one defect this whole change
 *  exists to prevent.
 */
export function formatOrgDateTimeShort(iso: string | null | undefined, timeZone?: string): string {
  return formatInOrgZone(iso, timeZone, (f) => `${f.month}/${f.day} ${f.hour}:${f.minute}`);
}

/** `2026年4月15日` / `Apr 15, 2026` — a calendar date with no time, rendered in
 *  the org's zone.
 *
 *  Deliberately NOT built from `formatOrgDateTime` by chopping the string: the
 *  two shapes order their parts differently per language and per zone, and a
 *  slice of one is not the other. The dashboard's greeting ("今天是 …") shows a
 *  date with no clock on it, and every analytics surface goes through here.
 */
export function formatOrgDate(iso: string | null | undefined, timeZone?: string): string {
  const zone = safeTimeZone(timeZone);
  if (!iso) return EMPTY_CELL;
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return EMPTY_CELL;
  const lang = getLang();
  try {
    const parts = partsInZone(date, zone);
    if (lang === 'zh') {
      return `${parts.year}年${Number(parts.month)}月${Number(parts.day)}日`;
    }
    const month = new Date(Date.UTC(2000, Number(parts.month) - 1, 1));
    const name = new Intl.DateTimeFormat('en-US', { month: 'short', timeZone: 'UTC' }).format(month);
    return `${name} ${Number(parts.day)}, ${parts.year}`;
  } catch {
    return lang === 'zh' ? `${date.getFullYear()}年${date.getMonth() + 1}月${date.getDate()}日`
                         : date.toDateString();
  }
}

/** `17:30` in the org's zone — the clock the greeting picks its band from.
 *
 *  Returns null rather than an em dash: the caller is branching on it (morning
 *  / afternoon / evening), and a string it has to string-compare is a worse
 *  contract than "no answer". */
export function formatOrgHour(iso: string | null | undefined, timeZone?: string): string | null {
  const zone = safeTimeZone(timeZone);
  if (!iso) return null;
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return null;
  try {
    const parts = partsInZone(date, zone);
    return `${parts.hour}:${parts.minute}`;
  } catch {
    const pad = (n: number): string => String(n).padStart(2, '0');
    return `${pad(date.getHours())}:${pad(date.getMinutes())}`;
  }
}

/** `Intl` rejects a zone string `orgs.timezone` may legitimately carry (it is
 *  free text with no validation). Best-effort by design, like every other
 *  formatter in this module: one unusable zone must not take a board down. */
function safeTimeZone(timeZone: string | undefined): string | undefined {
  if (!timeZone) return undefined;
  try {
    new Intl.DateTimeFormat('en-CA', { timeZone });
    return timeZone;
  } catch {
    return undefined;
  }
}
