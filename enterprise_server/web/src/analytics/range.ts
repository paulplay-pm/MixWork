/**
 * The range keys the analytics pages send, mirrored from
 * `enterprise_server/src/analytics/range.ts` (`UsageRange` / `AuditRange`).
 * The SPA does not import from the server's src/ — see the note at the top of
 * `src/shared/permissions.ts` for that convention — so this is a hand-kept
 * copy. Add a key server-side and update this file in the same change.
 *
 * The key is the ONLY thing the client sends. It never sends a date: the server
 * resolves the window in the org's timezone (see the server module's rationale
 * for the DST-safe day boundaries), so the page and its CSV cannot disagree
 * about which days a range covers. `custom` is the single exception — it names
 * both endpoints as `YYYY-MM-DD` days the user picked.
 */
import { t } from '../i18n';

export type UsageRangeKey = 'today' | '7d' | '30d' | 'this_month' | 'last_month';
export type AuditRangeKey = UsageRangeKey | 'custom';

/** The five preset windows, in the order the range pickers render them. */
export const USAGE_RANGE_KEYS: readonly UsageRangeKey[] = [
  'today',
  '7d',
  '30d',
  'this_month',
  'last_month',
];

/** The presets plus `custom`, which needs `from`/`to` beside it. */
export const AUDIT_RANGE_KEYS: readonly AuditRangeKey[] = [...USAGE_RANGE_KEYS, 'custom'];

/** i18n key for a range key's picker label. */
export const rangeOptionKey = (key: UsageRangeKey | AuditRangeKey): string => `analytics.range.${key}`;

/** Localized label for a range key, via `analytics.range.*` in both dictionaries. */
export function rangeOptionLabel(key: UsageRangeKey | AuditRangeKey): string {
  return t(rangeOptionKey(key));
}
