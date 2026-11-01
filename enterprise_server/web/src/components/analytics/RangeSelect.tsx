import type { JSX } from 'react';

import {
  AUDIT_RANGE_KEYS,
  type AuditRangeKey,
  rangeOptionLabel,
  USAGE_RANGE_KEYS,
  type UsageRangeKey,
} from '../../analytics/range';
import { t } from '../../i18n';

interface Props {
  value: UsageRangeKey | AuditRangeKey;
  onChange: (k: UsageRangeKey | AuditRangeKey) => void;
  /** `custom` only exists on the audit page, where a day picker sits beside it.
   * The usage page offers the five presets only. */
  allowCustom?: boolean;
}

/**
 * The window picker. Native `<select>` rather than a custom popover: the
 * platform picker is what makes this usable on a phone and reachable by
 * keyboard, and there is nothing here a custom widget would add.
 *
 * The key is the only thing it emits — never a date. The server resolves the
 * window in the org's timezone, so the table, the drawer and the CSV cannot
 * disagree about which days "近 7 天" covers.
 */
export function RangeSelect({ value, onChange, allowCustom = false }: Props): JSX.Element {
  const keys: readonly (UsageRangeKey | AuditRangeKey)[] = allowCustom
    ? AUDIT_RANGE_KEYS
    : USAGE_RANGE_KEYS;
  const label = t('analytics.range.label');

  return (
    <label className="flex items-center gap-2 text-xs text-[var(--text-secondary)]">
      {label}
      <select
        aria-label={label}
        className="rounded-[var(--radius-md)] border border-[var(--border-default)] bg-white px-2 py-1 text-xs text-[var(--text-primary)] focus:border-[var(--accent-primary)] focus:outline-none"
        value={value}
        onChange={(e) => onChange(e.target.value as UsageRangeKey | AuditRangeKey)}
      >
        {keys.map((k) => (
          <option key={k} value={k}>
            {rangeOptionLabel(k)}
          </option>
        ))}
      </select>
    </label>
  );
}