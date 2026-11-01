import type { JSX } from 'react';

import type { DashboardActivity } from '../../api/dashboard';
import { getLang, t } from '../../i18n';

export interface ActivityFeedProps {
  activities: DashboardActivity[];
  onItemClick?: (item: DashboardActivity) => void;
}

/**
 * Audit tone → dot colour. Deliberately NOT reusing `Badge`: the spec's four
 * bands are semantic (something broke / something risky / something new /
 * something fine) while the badge tones are categorical, and collapsing them
 * would paint a permission grant the same red as an outage.
 */
const DOT_CLASS: Record<string, string> = {
  failure: 'bg-[var(--danger-primary)]',
  danger: 'bg-[var(--danger-primary)]',
  change: 'bg-[var(--warning-primary)]',
  auth: 'bg-[var(--accent-primary)]',
  normal: 'bg-[var(--accent-primary)]',
  success: 'bg-[var(--success-primary)]',
};

const MS_PER_DAY = 86_400_000;

/** `HH:mm` today, `昨天 HH:mm`, `MM-DD HH:mm` beyond that.
 *
 *  Same calendar-day rule the audit page uses: "yesterday" is the reader's
 *  yesterday, and the comparison happens in the browser's zone because this is
 *  a relative label about the reader's own clock — unlike the org-zone
 *  formatting the analytics tables use for absolute instants. */
function relativeTime(iso: string, now: Date): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  const clock = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const at = d.getTime();
  if (at >= startOfToday) return clock;
  if (at >= startOfToday - MS_PER_DAY) return `${t('dashboard.activity.yesterday')} ${clock}`;
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${mm}-${dd} ${clock}`;
}

/**
 * The "what just happened" timeline.
 *
 * The sentence is composed HERE, in the browser, from labels the server
 * resolved — never from an action code. The server is the single authority on
 * what `provider_key_update` means (including for a code an authenticated
 * client invented), and it cannot know which language the reader picked.
 *
 * A row with no resolvable target name drops the target rather than printing
 * the UUID: "Updated provider key" is a complete sentence, and a raw id in the
 * middle of one is noise that reads as corruption.
 */
export function ActivityFeed({ activities, onItemClick }: ActivityFeedProps): JSX.Element | null {
  if (activities.length === 0) return null;
  const lang = getLang();
  const now = new Date();

  return (
    <ul data-testid="activity-list">
      {activities.map((a, i) => {
        const action = lang === 'zh' ? a.action_zh || a.action : a.action_en || a.action;
        const target =
          lang === 'zh' ? a.target_name_zh || a.target_name_en : a.target_name_en || a.target_name_zh;
        const actor = a.user_name ?? t('dashboard.activity.system');
        const isLast = i === activities.length - 1;
        return (
          <li key={a.id} className="relative pl-5">
            {/* The connector line, drawn by the item ABOVE this one so the last
                row has nothing dangling below it. */}
            {!isLast && (
              <span
                aria-hidden="true"
                className="absolute left-[3px] top-3 bottom-0 w-px bg-[var(--border-default)]"
              />
            )}
            <span
              data-testid="activity-dot"
              data-tone={a.tone}
              aria-hidden="true"
              className={`absolute left-0 top-[9px] h-2 w-2 rounded-full ${DOT_CLASS[a.tone] ?? DOT_CLASS.normal}`}
            />
            <button
              type="button"
              data-testid="activity-item"
              onClick={() => onItemClick?.(a)}
              className="w-full rounded py-2 pr-1 text-left transition-colors hover:bg-[var(--bg-hover)]/40"
            >
              <span className="block text-[13px] leading-5 text-[var(--text-primary)]">
                {target && <span className="font-medium">{target} </span>}
                {action}
              </span>
              <span className="mt-0.5 flex items-center gap-1.5 text-[11px] text-[var(--text-tertiary)]">
                <span data-testid="activity-time">{relativeTime(a.ts, now)}</span>
                <span aria-hidden="true">·</span>
                <span data-testid="activity-actor">{actor}</span>
              </span>
            </button>
          </li>
        );
      })}
    </ul>
  );
}